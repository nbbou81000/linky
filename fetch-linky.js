// fetch-linky.js
// Récupère toutes les données Linky disponibles via MyElectricalData
// et génère un data.json consolidé pour le plugin TRMNL.
//
// Variables d'environnement attendues (à mettre en secrets GitHub Actions) :
//   MED_TOKEN = ton token MyElectricalData
//   MED_PDL   = ton PDL (14 chiffres)
//
// Usage: node fetch-linky.js

const fs = require("fs");

const TOKEN = process.env.MED_TOKEN;
const PDL = process.env.MED_PDL;
const BASE = "https://www.myelectricaldata.fr";

if (!TOKEN || !PDL) {
  console.error("MED_TOKEN et MED_PDL doivent être définis.");
  process.exit(1);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function medFetch(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: TOKEN },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`⚠️  ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    return null;
  }
  return res.json();
}

// --- Helpers de calcul --------------------------------------------------

function sumInterval(readings) {
  if (!readings || !readings.length) return 0;
  return readings.reduce((acc, r) => acc + parseFloat(r.value || 0), 0);
}

function average(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// --- Main -----------------------------------------------------------------

async function main() {
  const today = new Date();
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 30);
  const start7 = new Date(today);
  start7.setDate(start7.getDate() - 7);
  const startLoadCurve = new Date(today);
  startLoadCurve.setDate(startLoadCurve.getDate() - 2); // courbe de charge : granularité fine, on limite à 2 jours

  const startStr30 = fmtDate(start30);
  const startStr7 = fmtDate(start7);
  const startStrLC = fmtDate(startLoadCurve);
  const todayStr = fmtDate(today);

  console.log("Fetching contract...");
  const contract = await medFetch(`/contracts/${PDL}/`);

  console.log("Fetching identity...");
  const identity = await medFetch(`/identity/${PDL}/`);

  console.log("Fetching addresses...");
  const addresses = await medFetch(`/addresses/${PDL}/`);

  console.log("Fetching daily consumption (30j)...");
  const dailyConso = await medFetch(
    `/daily_consumption/${PDL}/start/${startStr30}/end/${todayStr}`
  );

  console.log("Fetching daily consumption max power (30j)...");
  const dailyMaxPower = await medFetch(
    `/daily_consumption_max_power/${PDL}/start/${startStr30}/end/${todayStr}`
  );

  console.log("Fetching load curve (48h, pas 30min)...");
  const loadCurve = await medFetch(
    `/consumption_load_curve/${PDL}/start/${startStrLC}/end/${todayStr}`
  );

  // --- Traitement des données quotidiennes ---
  const dailyReadings =
    dailyConso?.meter_reading?.interval_reading || [];

  const dailySeries = dailyReadings.map((r) => ({
    date: r.date,
    kwh: parseFloat(r.value) / 1000, // Wh -> kWh
  }));

  const last7 = dailySeries.slice(-7);
  const last30 = dailySeries.slice(-30);

  const todayKwh = dailySeries.length ? dailySeries[dailySeries.length - 1].kwh : null;
  const yesterdayKwh =
    dailySeries.length > 1 ? dailySeries[dailySeries.length - 2].kwh : null;

  const avg7 = average(last7.map((d) => d.kwh));
  const avg30 = average(last30.map((d) => d.kwh));
  const total7 = last7.reduce((a, d) => a + d.kwh, 0);
  const total30 = last30.reduce((a, d) => a + d.kwh, 0);

  const maxDay = last30.reduce(
    (max, d) => (d.kwh > (max?.kwh ?? -1) ? d : max),
    null
  );
  const minDay = last30.reduce(
    (min, d) => (d.kwh < (min?.kwh ?? Infinity) ? d : min),
    null
  );

  // --- Puissance max ---
  const maxPowerReadings =
    dailyMaxPower?.meter_reading?.interval_reading || [];
  const maxPowerSeries = maxPowerReadings.map((r) => ({
    date: r.date,
    watts: parseFloat(r.value),
  }));
  const peakPower = maxPowerSeries.reduce(
    (max, d) => (d.watts > (max?.watts ?? -1) ? d : max),
    null
  );

  // --- Courbe de charge (dernières 48h, pas 30min) ---
  const loadCurveReadings =
    loadCurve?.meter_reading?.interval_reading || [];
  const loadCurveSeries = loadCurveReadings.map((r) => ({
    ts: r.date,
    watts: Math.round(parseFloat(r.value) * 2), // W30min -> W moyen
  }));

  // Puissance instantanée = dernier point de la courbe de charge
  const currentPower = loadCurveSeries.length
    ? loadCurveSeries[loadCurveSeries.length - 1]
    : null;

  // --- Assemblage du data.json ---
  const data = {
    generated_at: new Date().toISOString(),
    pdl: PDL,
    contract: contract?.customer?.usage_points?.[0]?.contracts || contract || null,
    identity: identity?.customer?.identity || identity || null,
    address: addresses?.customer?.usage_points?.[0]?.usage_point?.usage_point_addresses || addresses || null,

    today: {
      date: todayStr,
      kwh: todayKwh,
    },
    yesterday: {
      kwh: yesterdayKwh,
    },
    current_power_watts: currentPower ? currentPower.watts : null,
    peak_power: peakPower
      ? { date: peakPower.date, watts: peakPower.watts }
      : null,

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

    load_curve_48h: loadCurveSeries,
  };

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log("✅ data.json généré.");
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
