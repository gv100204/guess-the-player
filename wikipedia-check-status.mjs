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
  const fail = checked.filter((e) => e.verdict === "fail").length;
  const filled = checked.filter((e) => e.filledFromWikipediaAt).length;
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
  console.log(`  Falliscono: ${fail.toLocaleString("it-IT")}${filled ? ` (di cui ${filled} già riparati da Wikipedia)` : ""}`);
  console.log(`  Ancora da controllare: ${remaining.toLocaleString("it-IT")}`);

  if (fail > filled) {
    console.log(`\n${fail - filled} giocatori falliscono e non sono ancora stati riparati:`);
    console.log("  node apply-wikipedia-fills.mjs raw-players.json wikipedia-check.json");
  }
}

main();
