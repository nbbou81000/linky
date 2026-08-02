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
    const res = await medFetch(`/consumption_load_curve/${pdl}/start/${startStr}/end/${endStr}`);
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

async function main() {
  const today = new Date();
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 30);
  const todayStr = fmtDate(today);
  const startStr30 = fmtDate(start30);

  console.log("Fetching contract...");
  const contract = await medFetch(`/contracts/${PDL}/`);

  console.log("Fetching identity...");
  const identity = await medFetch(`/identity/${PDL}/`);

  console.log("Fetching addresses...");
  const addresses = await medFetch(`/addresses/${PDL}/`);

  console.log("Fetching daily consumption (30j)...");
  const dailyConso = await medFetch(`/daily_consumption/${PDL}/start/${startStr30}/end/${todayStr}`);

  console.log("Fetching daily consumption max power (30j)...");
  const dailyMaxPower = await medFetch(`/daily_consumption_max_power/${PDL}/start/${startStr30}/end/${todayStr}`);

  // La courbe de charge est volontairement limitée à 7j (une seule tranche) pour ménager
  // le quota MyElectricalData — largement suffisant pour les 48h affichées + un échantillon HP/HC.
  const start7ForLoadCurve = new Date(today);
  start7ForLoadCurve.setDate(start7ForLoadCurve.getDate() - 7);

  console.log("Fetching load curve (7j, pas 30min)...");
  const loadCurveReadings = await fetchLoadCurveChunked(PDL, start7ForLoadCurve, today);

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

  // --- Assemblage du data.json ---
  const data = {
    generated_at: new Date().toISOString(),
    generated_at_fr: datetimeFr(new Date().toISOString()),
    pdl: PDL,
    contract: contract?.customer?.usage_points?.[0]?.contracts || contract || null,
    identity: identity?.customer?.identity || identity || null,
    address: addresses?.customer?.usage_points?.[0]?.usage_point?.usage_point_addresses || addresses || null,
    offpeak_ranges: offpeakRanges,

    // "Dernier jour connu" avec sa vraie date Enedis (PAS forcément aujourd'hui : J+1 en théorie, parfois plus)
    last_known_day: lastAvailable
      ? { date: lastAvailable.date, date_fr: lastAvailable.date_fr, weekday_fr: lastAvailable.weekday_fr, kwh: lastAvailable.kwh, lag_days: dataLagDays }
      : null,
    yesterday: { kwh: yesterdayKwh },
    // Dernière puissance CONNUE (pas temps réel, voir commentaire plus haut)
    last_known_power: lastKnownPower
      ? { watts: lastKnownPower.watts, ts: lastKnownPower.ts, ts_fr: datetimeFr(lastKnownPower.ts) }
      : null,
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

    hphc: hphc,

    estimated_bill: estimateBill(Math.round(total30 * 100) / 100, hphc),

    load_curve_48h: loadCurve48h,

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
      load_curve: loadCurve48h.length
        ? buildLineChart(loadCurve48h.map((p) => ({ value: p.watts })), { width: 760, height: 95 })
        : null,
      hphc_bar: buildHphcBar(hphc, Math.round(total30 * 100) / 100, TARIFF.hc_pct_estimate, { width: 760 }),
    },
  };

  updateHistory(data.last_known_day, hphc);

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log("✅ data.json généré.");
  if (dataLagDays != null && dataLagDays > 1) {
    console.log(`⚠️  Dernier jour disponible = J-${dataLagDays} (Enedis publie normalement en J+1). Le cron tourne peut-être trop tôt, ou Enedis a du retard aujourd'hui.`);
  }
  if (!loadCurveReadings.length) {
    console.log("ℹ️  Courbe de charge vide : active la 'collecte enrichie' sur myelectricaldata.fr (24-48h de délai après activation).");
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
