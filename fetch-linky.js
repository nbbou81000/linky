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

async function medFetch(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`⚠️  ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
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

  console.log("Fetching load curve (30j, pas 30min)...");
  const loadCurve = await medFetch(`/consumption_load_curve/${PDL}/start/${startStr30}/end/${todayStr}`);

  // --- Consommation quotidienne ---
  const dailyReadings = dailyConso?.meter_reading?.interval_reading || [];
  const dailySeries = dailyReadings.map((r) => ({
    date: r.date,
    date_fr: dateFr(r.date),
    weekday_fr: weekdayFr(r.date),
    kwh: Math.round((parseFloat(r.value) / 1000) * 1000) / 1000,
  }));

  const last7 = dailySeries.slice(-7);
  const last30 = dailySeries.slice(-30);

  const todayKwh = dailySeries.length ? dailySeries[dailySeries.length - 1].kwh : null;
  const yesterdayKwh = dailySeries.length > 1 ? dailySeries[dailySeries.length - 2].kwh : null;

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
  const loadCurveReadings = loadCurve?.meter_reading?.interval_reading || [];
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

    today: { date: todayStr, date_fr: dateFr(todayStr), kwh: todayKwh },
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
  };

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log("✅ data.json généré.");
  if (!loadCurveReadings.length) {
    console.log("ℹ️  Courbe de charge vide : active la 'collecte enrichie' sur myelectricaldata.fr (24-48h de délai après activation).");
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
