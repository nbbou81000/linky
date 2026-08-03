// fetch-linky.js
// Récupère toutes les données Linky disponibles via MyElectricalData
// et génère un data.json consolidé pour le plugin TRMNL + le dashboard HTML.
//
// Variables d'environnement attendues (secrets GitHub Actions) :
//   MED_TOKEN = ton token MyElectricalData
//   MED_PDL   = ton PDL (14 chiffres)

const fs = require("fs");

const TOKEN = process.env.MED_TOKEN;
const PDL = process.env.MED_PDL;
const BASE = "https://www.myelectricaldata.fr";

if (!TOKEN || !PDL) {
  console.error("MED_TOKEN et MED_PDL doivent être définis.");
  process.exit(1);
}

const JOURS_FR = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
const MOIS_FR = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function dateFr(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return `${d.getDate()} ${MOIS_FR[d.getMonth()]}`;
}
function dateDdMm(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function weekdayFr(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return "";
  return JOURS_FR[d.getDay()];
}
function datetimeFr(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

let rateLimited = false; // passe à true dès qu'un 429 est rencontré, pour arrêter les tentatives inutiles

async function medFetch(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`⚠️  ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    if (res.status === 429) rateLimited = true;
    return null;
  }
  return res.json();
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// --- Parsing des heures creuses depuis le contrat -------------------------
// Format Enedis typique : "HC (1H02-6H02;14H02-17H02)"
function parseOffpeakRanges(offpeakStr) {
  if (!offpeakStr) return [];
  const matches = [...offpeakStr.matchAll(/(\d{1,2})H(\d{2})-(\d{1,2})H(\d{2})/g)];
  return matches.map((m) => ({
    startMin: parseInt(m[1]) * 60 + parseInt(m[2]),
    endMin: parseInt(m[3]) * 60 + parseInt(m[4]),
  }));
}
function isOffpeak(date, ranges) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return ranges.some((r) => {
    if (r.startMin <= r.endMin) return minutes >= r.startMin && minutes < r.endMin;
    return minutes >= r.startMin || minutes < r.endMin;
  });
}

// Tarif Bleu EDF réglementé (option HP/HC, >=9kVA) au 1er août 2026.
// À AJUSTER si tu es sur une offre de marché plutôt que le tarif réglementé.
const TARIFF = {
  hp_price: 0.2065,
  hc_price: 0.1579,
  subscription_monthly: 19.2,
  hc_pct_estimate: 30, // hypothèse si la courbe de charge n'est pas encore active
};

function estimateBill(monthTotalKwh, hphc) {
  if (!monthTotalKwh) return null;
  let hcKwh, hpKwh, source;
  if (hphc && hphc.hc_pct != null) {
    hcKwh = monthTotalKwh * (hphc.hc_pct / 100);
    source = "measured";
  } else {
    hcKwh = monthTotalKwh * (TARIFF.hc_pct_estimate / 100);
    source = "estimated";
  }
  hpKwh = monthTotalKwh - hcKwh;
  const hpEur = hpKwh * TARIFF.hp_price;
  const hcEur = hcKwh * TARIFF.hc_price;
  const totalEur = hpEur + hcEur + TARIFF.subscription_monthly;
  return {
    source, // "measured" (courbe de charge réelle) ou "estimated" (hypothèse HC 30%)
    period_days: 30,
    hp_kwh: Math.round(hpKwh * 100) / 100,
    hc_kwh: Math.round(hcKwh * 100) / 100,
    hp_eur: Math.round(hpEur * 100) / 100,
    hc_eur: Math.round(hcEur * 100) / 100,
    subscription_eur: TARIFF.subscription_monthly,
    total_eur: Math.round(totalEur * 100) / 100,
  };
}

// --- Géométrie SVG pré-calculée pour le mode "graphiques" (pas de JS sur l'écran, tout est statique) ---

function buildBarChart(items, { width = 760, height = 90, gap = 6 } = {}) {
  const n = items.length;
  if (!n) return null;
  const barW = (width - gap * (n - 1)) / n;
  const maxVal = Math.max(...items.map((d) => d.value), 0.001);
  const bars = items.map((d, i) => {
    const h = Math.max(2, Math.round((d.value / maxVal) * height));
    const x = Math.round(i * (barW + gap));
    const w = Math.round(barW);
    return {
      x,
      y: height - h,
      w,
      h,
      cx: Math.round(x + w / 2), // centre horizontal pré-calculé pour les <text>
      value: d.value,
      label: d.label,
      highlight: !!d.highlight,
    };
  });
  return { width, height, bars, max_value: Math.round(maxVal * 100) / 100 };
}

function buildLineChart(points, { width = 760, height = 95, padding = 6 } = {}) {
  const n = points.length;
  if (n < 2) return null;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const coords = points.map((p, i) => {
    const x = Math.round((i / (n - 1)) * width);
    const y = Math.round(height - padding - ((p.value - minV) / range) * (height - 2 * padding));
    return { x, y };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1].x},${height} L${coords[0].x},${height} Z`;
  return { width, height, line_path: linePath, area_path: areaPath, min_value: Math.round(minV), max_value: Math.round(maxV) };
}

function buildHphcBar(hphc, monthTotal, tariffHcPctEstimate, { width = 760 } = {}) {
  let hcPct;
  let measured = false;
  if (hphc && hphc.hc_pct != null) {
    hcPct = hphc.hc_pct;
    measured = true;
  } else {
    hcPct = tariffHcPctEstimate;
  }
  const hpPct = 100 - hcPct;
  return {
    measured,
    hp_pct: Math.round(hpPct * 10) / 10,
    hc_pct: Math.round(hcPct * 10) / 10,
    hp_width: Math.round((hpPct / 100) * width),
    hc_width: Math.round((hcPct / 100) * width),
    hc_x: Math.round((hpPct / 100) * width),
  };
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// L'endpoint consumption_load_curve refuse plus de 7 jours consécutifs par requête
// (contrairement à daily_consumption qui accepte 30j) : on découpe en tranches.
async function fetchLoadCurveChunked(pdl, startDate, endDate) {
  const readings = [];
  let chunkStart = new Date(startDate);
  const end = new Date(endDate);
  while (chunkStart < end) {
    if (rateLimited) {
      console.log("⏭️  Quota atteint, arrêt des tranches de courbe de charge restantes pour cette exécution.");
      break;
    }
    let chunkEnd = addDays(chunkStart, 7);
    if (chunkEnd > end) chunkEnd = end;
    const startStr = fmtDate(chunkStart);
    const endStr = fmtDate(chunkEnd);
    console.log(`Fetching load curve chunk ${startStr} -> ${endStr}...`);
    const res = await medFetch(`/consumption_load_curve/${pdl}/start/${startStr}/end/${endStr}/cache/`);
    const chunkReadings = res?.meter_reading?.interval_reading || [];
    readings.push(...chunkReadings);
    chunkStart = chunkEnd;
  }
  return readings;
}

// --- Historique long terme : contrairement à data.json (fenêtre glissante 30j), on accumule
// un point par jour dans history.json, qui grossit indéfiniment (jamais tronqué).
function updateHistory(lastKnownDay, hphc) {
  const HISTORY_PATH = "history.json";
  let history = [];
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    }
  } catch (e) {
    console.warn("⚠️  history.json illisible, on repart d'un historique vide:", e.message);
  }
  if (lastKnownDay && lastKnownDay.date) {
    const entry = {
      date: lastKnownDay.date,
      kwh: lastKnownDay.kwh,
      hc_pct: hphc && hphc.hc_pct != null ? hphc.hc_pct : null,
    };
    const idx = history.findIndex((h) => h.date === entry.date);
    if (idx >= 0) history[idx] = entry;
    else history.push(entry);
    history.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`✅ history.json mis à jour (${history.length} jours au total).`);
  return history;
}

// --- Analyse météo (portée depuis le dashboard HTML pour pouvoir l'afficher sur TRMNL,
// où il n'y a pas de JS/réseau côté écran : tout doit être précalculé ici) ---

// Petit retry générique : les blips réseau transitoires (DNS, timeout) sont fréquents
// sur les runners GitHub Actions, mieux vaut réessayer 2-3 fois avant d'abandonner.
async function fetchWithRetry(url, attempts = 3, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function geocodeAddress(addr) {
  if (!addr || !addr.city) return null;
  try {
    const q = encodeURIComponent(addr.city);
    const cp = addr.postal_code ? `&postcode=${addr.postal_code}` : "";
    const res = await fetchWithRetry(`https://data.geopf.fr/geocodage/search?q=${q}${cp}&limit=1&type=municipality`);
    const j = await res.json();
    const f = j.features && j.features[0];
    if (!f) return null;
    return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  } catch (e) {
    console.warn("⚠️  Géocodage impossible après plusieurs tentatives:", e.message);
    return null;
  }
}

async function fetchDailyTempsNode(lat, lon, pastDays, forecastDays) {
  const res = await fetchWithRetry(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_mean&past_days=${Math.min(pastDays + 2, 92)}&forecast_days=${forecastDays}&timezone=Europe%2FParis`
  );
  const j = await res.json();
  const map = {};
  (j.daily.time || []).forEach((d, i) => {
    map[d] = j.daily.temperature_2m_mean[i];
  });
  return map;
}

function solve3x3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-9) return null;
    for (let k = i + 1; k < 3; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = M[i][3];
    for (let j = i + 1; j < 3; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

function degreeDayRegression(points, hddBase, cddBase) {
  const n = points.length;
  if (n < 5) return null;
  let S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let Y = [0, 0, 0];
  points.forEach((p) => {
    const hdd = Math.max(0, hddBase - p.temp);
    const cdd = Math.max(0, p.temp - cddBase);
    const row = [1, hdd, cdd];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) S[i][j] += row[i] * row[j];
      Y[i] += row[i] * p.kwh;
    }
  });
  const lambda = 1e-6 * n;
  for (let i = 0; i < 3; i++) S[i][i] += lambda;
  const beta = solve3x3(S, Y);
  if (!beta) return null;
  const [base, hddCoeff, cddCoeff] = beta;
  return { base: Math.max(0, base), hddCoeff: Math.max(0, hddCoeff), cddCoeff: Math.max(0, cddCoeff) };
}

async function buildWeatherInsight(address, dailySeries, blendedPrice) {
  const HDD_BASE = 18;
  const CDD_BASE = 24;
  try {
    const geo = await geocodeAddress(address);
    if (!geo) return null;
    const firstDate = new Date(dailySeries[0].date);
    const daysSpan = Math.ceil((Date.now() - firstDate.getTime()) / 86400000) + 1;
    const temps = await fetchDailyTempsNode(geo.lat, geo.lon, daysSpan, 6);

    const points = dailySeries
      .map((d) => ({ date: d.date, date_ddmm: d.date_ddmm, kwh: d.kwh, temp: temps[d.date] }))
      .filter((p) => p.temp != null);
    if (points.length < 5) return null;

    const model = degreeDayRegression(points, HDD_BASE, CDD_BASE);
    if (!model) return null;

    let heatKwh = 0,
      coolKwh = 0,
      baseKwh = 0;
    const residuals = points.map((p) => {
      const hdd = Math.max(0, HDD_BASE - p.temp);
      const cdd = Math.max(0, p.temp - CDD_BASE);
      const predicted = model.base + model.hddCoeff * hdd + model.cddCoeff * cdd;
      heatKwh += model.hddCoeff * hdd;
      coolKwh += model.cddCoeff * cdd;
      baseKwh += model.base;
      return p.kwh - predicted;
    });
    const meanRes = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const variance = residuals.reduce((a, b) => a + (b - meanRes) * (b - meanRes), 0) / residuals.length;
    const stdRes = Math.sqrt(variance) || 1;
    const lastZ = residuals[residuals.length - 1] / stdRes;
    let statusLabel;
    if (lastZ >= 2) statusLabel = "Anormalement élevée";
    else if (lastZ >= 1) statusLabel = "Un peu élevée";
    else if (lastZ <= -1.5) statusLabel = "Basse";
    else statusLabel = "Normale";

    const todayIso = new Date().toISOString().slice(0, 10);
    const forecastDates = Object.keys(temps)
      .filter((d) => d > todayIso)
      .sort()
      .slice(0, 5);
    const forecast = forecastDates.map((d) => {
      const temp = temps[d];
      const hdd = Math.max(0, HDD_BASE - temp);
      const cdd = Math.max(0, temp - CDD_BASE);
      const predKwh = Math.max(0, model.base + model.hddCoeff * hdd + model.cddCoeff * cdd);
      const dd = new Date(d);
      return {
        date_ddmm: `${String(dd.getDate()).padStart(2, "0")}/${String(dd.getMonth() + 1).padStart(2, "0")}`,
        temp: Math.round(temp * 10) / 10,
        kwh: Math.round(predKwh * 10) / 10,
        eur: Math.round(predKwh * blendedPrice * 100) / 100,
      };
    });

    return {
      hdd_base: HDD_BASE,
      cdd_base: CDD_BASE,
      heat_kwh: Math.round(heatKwh * 10) / 10,
      cool_kwh: Math.round(coolKwh * 10) / 10,
      base_kwh: Math.round(baseKwh * 10) / 10,
      eur_per_degree_heat: Math.round(model.hddCoeff * blendedPrice * 100) / 100,
      status_label: statusLabel,
      status_z: Math.round(lastZ * 10) / 10,
      forecast,
      forecast_total_kwh: Math.round(forecast.reduce((a, f) => a + f.kwh, 0) * 10) / 10,
      forecast_total_eur: Math.round(forecast.reduce((a, f) => a + f.eur, 0) * 100) / 100,
      n_days: points.length,
    };
  } catch (e) {
    console.warn("⚠️  Analyse météo impossible:", e.message);
    return null;
  }
}

// --- Écran dédié "Courbe 48h" : géométrie riche (lissage, bandes jour/nuit, marqueurs min/max,
// repère minuit) précalculée pour un rendu SVG élégant sans JS côté écran.
function smoothPath(coords) {
  if (coords.length < 3) {
    return coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
  }
  let d = `M${coords[0].x},${coords[0].y}`;
  for (let i = 1; i < coords.length - 1; i++) {
    const midX = (coords[i].x + coords[i + 1].x) / 2;
    const midY = (coords[i].y + coords[i + 1].y) / 2;
    d += ` Q${coords[i].x},${coords[i].y} ${midX},${midY}`;
  }
  const last = coords[coords.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

function buildLoadCurveDetail(loadCurve48h, { width = 760, height = 300, padding = 10 } = {}) {
  const n = loadCurve48h.length;
  if (n < 4) return null;

  const values = loadCurve48h.map((p) => p.watts);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const avgV = Math.round(values.reduce((a, b) => a + b, 0) / n);

  const coords = loadCurve48h.map((p, i) => {
    const x = Math.round((i / (n - 1)) * width);
    const y = Math.round(height - padding - ((p.watts - minV) / range) * (height - 2 * padding));
    return { x, y, watts: p.watts, ts: p.ts };
  });

  const linePath = smoothPath(coords);
  const areaPath = `${linePath} L${coords[coords.length - 1].x},${height} L${coords[0].x},${height} Z`;

  // Marqueurs min/max
  const minIdx = values.indexOf(minV);
  const maxIdx = values.indexOf(maxV);
  const minPoint = { ...coords[minIdx], label_y: Math.min(height - padding, coords[minIdx].y + 18) };
  const maxPoint = { ...coords[maxIdx], label_y: Math.max(padding + 12, coords[maxIdx].y - 10) };
  const currentPoint = coords[coords.length - 1];

  // Bandes nocturnes (22h-7h), pour le contexte visuel jour/nuit
  const nightBands = [];
  let bandStart = null;
  coords.forEach((c, i) => {
    const h = new Date(c.ts).getHours();
    const isNight = h >= 22 || h < 7;
    if (isNight && bandStart === null) bandStart = c.x;
    if (!isNight && bandStart !== null) {
      nightBands.push({ x: bandStart, w: c.x - bandStart });
      bandStart = null;
    }
  });
  if (bandStart !== null) nightBands.push({ x: bandStart, w: width - bandStart });

  // Repère minuit (changement de jour), pour séparer "hier" / "aujourd'hui"
  let dayBoundaryX = null;
  for (let i = 1; i < coords.length; i++) {
    const prevDate = new Date(coords[i - 1].ts).getDate();
    const curDate = new Date(coords[i].ts).getDate();
    if (prevDate !== curDate) {
      dayBoundaryX = coords[i].x;
      break;
    }
  }

  // Repères horaires (toutes les 6h : 00h/06h/12h/18h) pour un axe de temps lisible
  const hourTicks = [];
  coords.forEach((c) => {
    const d = new Date(c.ts);
    const h = d.getHours();
    const m = d.getMinutes();
    if (h % 6 === 0 && m === 0) {
      hourTicks.push({ x: c.x, label: `${String(h).padStart(2, "0")}h` });
    }
  });

  return {
    width,
    height,
    total_height: height + 22, // + espace réservé pour l'axe horaire en bas
    line_path: linePath,
    area_path: areaPath,
    min_value: minV,
    max_value: maxV,
    avg_value: avgV,
    min_point: minPoint,
    max_point: maxPoint,
    current_point: currentPoint,
    night_bands: nightBands,
    day_boundary_x: dayBoundaryX,
    hour_ticks: hourTicks,
  };
}

async function main() {
  // On relit l'ancien data.json (s'il existe) pour pouvoir réutiliser la courbe de charge / HP/HC /
  // dernière puissance en cas d'échec du fetch (quota MyElectricalData atteint, etc.) plutôt que
  // d'écraser avec du vide.
  let previousData = null;
  try {
    if (fs.existsSync("data.json")) {
      previousData = JSON.parse(fs.readFileSync("data.json", "utf8"));
    }
  } catch (e) {
    console.warn("⚠️  Impossible de lire l'ancien data.json:", e.message);
  }

  const today = new Date();
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 30);
  const todayStr = fmtDate(today);
  const startStr30 = fmtDate(start30);

  console.log("Fetching contract...");
  const contract = await medFetch(`/contracts/${PDL}/cache/`);

  // Note : l'endpoint identity (nom/prénom du titulaire) n'est plus appelé — cette info
  // n'est jamais exposée dans data.json (page publique), pas la peine de la récupérer.

  console.log("Fetching addresses...");
  const addresses = await medFetch(`/addresses/${PDL}/cache/`);

  console.log("Fetching daily consumption (30j)...");
  const dailyConso = await medFetch(`/daily_consumption/${PDL}/start/${startStr30}/end/${todayStr}/cache/`);

  console.log("Fetching daily consumption max power (30j)...");
  const dailyMaxPower = await medFetch(`/daily_consumption_max_power/${PDL}/start/${startStr30}/end/${todayStr}/cache/`);

  // Avec le cache MyElectricalData actif (quota plus généreux), on récupère 30j de courbe
  // de charge (5 tranches de 7j max/appel, limite côté Enedis) plutôt que 7j seulement
  // — HP/HC et historique bien plus précis.
  console.log("Fetching load curve (30j, pas 30min, par tranches de 7j)...");
  const loadCurveReadings = await fetchLoadCurveChunked(PDL, start30, today);

  // --- Consommation quotidienne ---
  const dailyReadings = dailyConso?.meter_reading?.interval_reading || [];
  const dailySeries = dailyReadings.map((r) => ({
    date: r.date,
    date_fr: dateFr(r.date),
    date_ddmm: dateDdMm(r.date),
    weekday_fr: weekdayFr(r.date),
    kwh: Math.round((parseFloat(r.value) / 1000) * 1000) / 1000,
  }));

  const last7 = dailySeries.slice(-7);
  const last30 = dailySeries.slice(-30);

  const yesterdayKwh = dailySeries.length > 1 ? dailySeries[dailySeries.length - 2].kwh : null;
  const lastAvailable = dailySeries.length ? dailySeries[dailySeries.length - 1] : null;
  // Écart entre la date du jour d'exécution et la date réelle du dernier point Enedis (J+1 en théorie, parfois plus)
  const dataLagDays = lastAvailable
    ? Math.round((new Date(todayStr) - new Date(lastAvailable.date)) / 86400000)
    : null;

  const avg7 = average(last7.map((d) => d.kwh));
  const avg30 = average(last30.map((d) => d.kwh));
  const total7 = last7.reduce((a, d) => a + d.kwh, 0);
  const total30 = last30.reduce((a, d) => a + d.kwh, 0);

  const maxDay = last30.reduce((max, d) => (d.kwh > (max?.kwh ?? -1) ? d : max), null);
  const minDay = last30.reduce((min, d) => (d.kwh < (min?.kwh ?? Infinity) ? d : min), null);

  // --- Puissance max ---
  const maxPowerReadings = dailyMaxPower?.meter_reading?.interval_reading || [];
  const maxPowerSeries = maxPowerReadings.map((r) => ({
    date: r.date,
    date_fr: dateFr(r.date),
    watts: parseFloat(r.value),
  }));
  const peakPower = maxPowerSeries.reduce((max, d) => (d.watts > (max?.watts ?? -1) ? d : max), null);

  // --- Courbe de charge (30 derniers jours, pas 30 min) ---
  const loadCurveSeries = loadCurveReadings.map((r) => ({
    ts: r.date,
    watts: Math.round(parseFloat(r.value) * 2),
  }));

  // Attention : ce n'est PAS une puissance "en temps réel". Enedis publie la courbe de
  // charge avec un décalage (souvent J-1 ou J-2) : c'est le dernier point CONNU, pas l'instant présent.
  const lastKnownPower = loadCurveSeries.length ? loadCurveSeries[loadCurveSeries.length - 1] : null;

  // On garde 2 jours pour l'export (poids du JSON), le HP/HC est calculé sur les 30j.
  const loadCurve48h = loadCurveSeries.slice(-96);

  // --- Classification HP/HC ---
  const offpeakStr =
    contract?.customer?.usage_points?.[0]?.contracts?.offpeak_hours || contract?.offpeak_hours || null;
  const offpeakRanges = parseOffpeakRanges(offpeakStr);
  let hphc = null;
  if (loadCurveReadings.length && offpeakRanges.length) {
    let hcWh = 0;
    let hpWh = 0;
    for (const r of loadCurveReadings) {
      const d = new Date(r.date);
      const wh = parseFloat(r.value) / 2;
      if (isOffpeak(d, offpeakRanges)) hcWh += wh;
      else hpWh += wh;
    }
    const totalWh = hcWh + hpWh;
    hphc = {
      source: "load_curve",
      hc_kwh: Math.round((hcWh / 1000) * 100) / 100,
      hp_kwh: Math.round((hpWh / 1000) * 100) / 100,
      hc_pct: totalWh ? Math.round((hcWh / totalWh) * 1000) / 10 : null,
    };
  }

  const lastKnownPowerObj = lastKnownPower
    ? { watts: lastKnownPower.watts, ts: lastKnownPower.ts, ts_fr: datetimeFr(lastKnownPower.ts) }
    : null;

  // --- Repli sur le cache si la courbe de charge n'a pas pu être récupérée (quota atteint, etc.) ---
  // On garde les dernières bonnes données plutôt que d'écraser avec du vide.
  let effectiveLoadCurve48h = loadCurve48h;
  let effectiveHphc = hphc;
  let effectiveLastKnownPower = lastKnownPowerObj;
  let loadCurveCache = null;
  if (!loadCurveReadings.length && previousData && previousData.load_curve_48h && previousData.load_curve_48h.length) {
    console.log(`ℹ️  Courbe de charge vide sur cet appel${rateLimited ? " (quota atteint)" : ""} : réutilisation des dernières données connues du ${previousData.generated_at_fr || previousData.generated_at}.`);
    effectiveLoadCurve48h = previousData.load_curve_48h;
    effectiveHphc = previousData.hphc || null;
    effectiveLastKnownPower = previousData.last_known_power || null;
    loadCurveCache = {
      stale: true,
      reason: rateLimited ? "quota" : "no_data",
      cached_at: previousData.generated_at,
      cached_at_fr: previousData.generated_at_fr || null,
    };
  }

  // --- Assemblage du data.json (page publique : on masque tout ce qui identifie la personne) ---
  const fullAddress = addresses?.customer?.usage_points?.[0]?.usage_point?.usage_point_addresses || addresses || null;
  const fullContract = contract?.customer?.usage_points?.[0]?.contracts || contract || null;

  const data = {
    generated_at: new Date().toISOString(),
    generated_at_fr: datetimeFr(new Date().toISOString()),
    pdl: PDL.slice(0, 4) + "••••••••••", // jamais le PDL complet dans le JSON public
    // Uniquement les infos de contrat utiles au calcul HP/HC, pas de segment/statut/n° contrat
    contract: fullContract
      ? { offpeak_hours: fullContract.offpeak_hours || null, subscribed_power: fullContract.subscribed_power || null }
      : null,
    // Ville + code postal seulement (nécessaire pour la météo), jamais la rue ni le nom du titulaire
    address: fullAddress ? { city: fullAddress.city || null, postal_code: fullAddress.postal_code || null } : null,
    offpeak_ranges: offpeakRanges,

    // "Dernier jour connu" avec sa vraie date Enedis (PAS forcément aujourd'hui : J+1 en théorie, parfois plus)
    last_known_day: lastAvailable
      ? { date: lastAvailable.date, date_fr: lastAvailable.date_fr, weekday_fr: lastAvailable.weekday_fr, kwh: lastAvailable.kwh, lag_days: dataLagDays }
      : null,
    yesterday: { kwh: yesterdayKwh },
    // Dernière puissance CONNUE (pas temps réel, voir commentaire plus haut)
    last_known_power: effectiveLastKnownPower,
    peak_power: peakPower ? { date: peakPower.date, date_fr: peakPower.date_fr, watts: peakPower.watts } : null,

    week: {
      total_kwh: Math.round(total7 * 100) / 100,
      avg_kwh_per_day: Math.round(avg7 * 100) / 100,
      series: last7,
    },
    month: {
      total_kwh: Math.round(total30 * 100) / 100,
      avg_kwh_per_day: Math.round(avg30 * 100) / 100,
      max_day: maxDay,
      min_day: minDay,
      series: last30,
    },

    hphc: effectiveHphc,
    load_curve_cache: loadCurveCache, // non-null si on affiche des données de courbe de charge périmées (cache)

    estimated_bill: estimateBill(Math.round(total30 * 100) / 100, effectiveHphc),

    load_curve_48h: effectiveLoadCurve48h,

    // Géométrie SVG prête à l'emploi pour le mode "graphiques" du plugin (aucun calcul côté Liquid)
    charts: {
      daily_14: (() => {
        const items = last30.slice(-14).map((d) => ({ value: d.kwh, label: d.date_ddmm }));
        if (items.length) {
          const maxIdx = items.reduce((best, it, i) => (it.value > items[best].value ? i : best), 0);
          items[maxIdx].highlight = true;
        }
        return buildBarChart(items, { width: 760, height: 90, gap: 6 });
      })(),
      load_curve: effectiveLoadCurve48h.length
        ? buildLineChart(effectiveLoadCurve48h.map((p) => ({ value: p.watts })), { width: 760, height: 95 })
        : null,
      hphc_bar: buildHphcBar(effectiveHphc, Math.round(total30 * 100) / 100, TARIFF.hc_pct_estimate, { width: 760 }),
      load_curve_detail: effectiveLoadCurve48h.length
        ? buildLoadCurveDetail(effectiveLoadCurve48h, { width: 760, height: 300 })
        : null,
    },
  };

  console.log("Building weather insight (géocodage + Open-Meteo + régression)...");
  data.weather_insight = await buildWeatherInsight(fullAddress, last30, TARIFF.hp_price);
  if (!data.weather_insight && previousData && previousData.weather_insight) {
    console.log("ℹ️  Analyse météo indisponible cette fois : réutilisation de celle du run précédent.");
    data.weather_insight = previousData.weather_insight;
  }

  updateHistory(data.last_known_day, effectiveHphc);

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log("✅ data.json généré.");
  if (dataLagDays != null && dataLagDays > 1) {
    console.log(`⚠️  Dernier jour disponible = J-${dataLagDays} (Enedis publie normalement en J+1). Le cron tourne peut-être trop tôt, ou Enedis a du retard aujourd'hui.`);
  }
  if (!loadCurveReadings.length) {
    if (loadCurveCache) {
      console.log(`ℹ️  Courbe de charge non récupérée cette fois (${loadCurveCache.reason === "quota" ? "quota atteint" : "pas de données"}) — données du ${loadCurveCache.cached_at_fr} réutilisées.`);
    } else {
      console.log("ℹ️  Courbe de charge vide : active la 'collecte enrichie' sur myelectricaldata.fr (24-48h de délai après activation).");
    }
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
