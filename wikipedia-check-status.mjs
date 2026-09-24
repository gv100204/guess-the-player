// ---------------------------------------------------------------------------
// wikipedia-check-status.mjs
//
// Mostra a che punto è il controllo Wikipedia: quanti giocatori sono stati
// controllati finora, quanti mancano, quanti passano/falliscono.
//
// NON fa nessuna chiamata di rete: legge solo raw-players.json e
// wikipedia-check.json, entrambi già sul disco. Puoi lanciarlo in
// un'altra finestra del terminale MENTRE verify-against-wikipedia.mjs
// continua a girare nell'altra - non c'è conflitto, sta solo leggendo.
//
// Uso:
//   node wikipedia-check-status.mjs [raw-players.json] [wikipedia-check.json]
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";

const RAW_FILE = process.argv[2] || "./raw-players.json";
const CHECK_FILE = process.argv[3] || "./wikipedia-check.json";

async function main() {
  const raw = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
  const players = raw.players || [];
  // Stesso identico criterio di pickCandidates in verify-against-wikipedia.mjs:
  // solo i già arricchiti sono idonei al controllo.
  const eligible = players.filter((p) => p.careerBackfilled).length;

  let checkData;
  try {
    checkData = JSON.parse(await fs.readFile(CHECK_FILE, "utf-8"));
  } catch {
    checkData = { checked: {} };
  }
  const checked = Object.values(checkData.checked);
  const total = checked.length;
  const ok = checked.filter((e) => e.verdict === "ok").length;
  const failEntries = checked.filter((e) => e.verdict === "fail");
  const fail = failEntries.length;
  // Solo tra chi fallisce ANCORA ADESSO: quanti hanno comunque ricevuto una
  // riparazione parziale (alcune tappe aggiunte, ma non tutte - altrimenti
  // sarebbero già passati a "ok"). Bug reale corretto: prima contava TUTTI
  // i giocatori mai riparati nella storia, anche quelli già passati a "ok",
  // producendo numeri assurdi tipo "82 riparati su 7 falliti".
  const partiallyFilled = failEntries.filter((e) => e.filledFromWikipediaAt).length;
  const remaining = Math.max(0, eligible - total);
  const pct = eligible > 0 ? (total / eligible) * 100 : 0;

  const barLength = 30;
  const filledBar = Math.round((pct / 100) * barLength);
  const bar = "#".repeat(filledBar) + "-".repeat(barLength - filledBar);

  console.log(`Giocatori idonei al controllo (già arricchiti): ${eligible.toLocaleString("it-IT")}`);
  console.log(`Controllati finora: ${total.toLocaleString("it-IT")}`);
  console.log(`[${bar}] ${pct.toFixed(1)}%`);
  console.log();
  console.log(`  Passano:    ${ok.toLocaleString("it-IT")}`);
  console.log(`  Falliscono: ${fail.toLocaleString("it-IT")}${partiallyFilled ? ` (di cui ${partiallyFilled} riparati solo in parte)` : ""}`);
  console.log(`  Ancora da controllare: ${remaining.toLocaleString("it-IT")}`);

  if (fail > 0) {
    console.log(`\n${fail} giocatori falliscono e non sono stati riparati del tutto:`);
    console.log("  node apply-wikipedia-fills.mjs raw-players.json wikipedia-check.json");
  }
}

main();
