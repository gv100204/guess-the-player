// ANTEPRIMA del rattoppo (apply-wikipedia-fills.mjs): NON scrive nessun file.
// Dice quante tappe mancanti verrebbero aggiunte, quante verrebbero scartate
// e perché, e quanti giocatori resterebbero con dei buchi (quindi fuori dal
// gioco) anche dopo il rattoppo.
//
// Uso: node fill-preview.mjs [raw-players.json] [wikipedia-check.json]
//
// Il filtro isPlausible è una COPIA di quello in apply-wikipedia-fills.mjs:
// se cambi uno, cambia anche l'altro.
import fs from "node:fs/promises";

const RAW = process.argv[2] || "./raw-players.json";
const CHECK = process.argv[3] || "./wikipedia-check.json";
const MAX_SPAN = 30;

function whyNotPlausible(e) {
  if (!e.apps || e.apps <= 0) return "senza presenze (vuote o 0)";
  if (e.to < e.from) return "anni incoerenti";
  if (e.to - e.from > MAX_SPAN) return "intervallo assurdo";
  if (!e.team || e.team.trim().length < 2) return "nome troppo corto";
  return null;
}

// Stesso criterio "riserva" usato nella scansione (dopo B -> II)
function looksReserve(team) {
  const n = (team || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return / (b|c|ii|iii)$/.test(n);
}

const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));
const check = JSON.parse(await fs.readFile(CHECK, "utf-8"));
const byId = new Map((raw.players || []).map((p) => [String(p.id), p]));

let failPlayers = 0, missingTotal = 0, addable = 0;
const skippedBy = new Map();
let playersFullyRepaired = 0, playersLeftWithHoles = 0, playersLeftOnlyBecauseNoApps = 0;
let reserveMissing = 0, reserveSkippedNoApps = 0;
const noAppsExamples = [];

for (const [id, entry] of Object.entries(check.checked)) {
  if (entry.verdict !== "fail") continue;
  if (!byId.has(String(id))) continue;
  failPlayers++;
  let allResolvable = true;
  let onlyNoApps = true;
  for (const m of entry.missing || []) {
    missingTotal++;
    const isRes = looksReserve(m.team);
    if (isRes) reserveMissing++;
    const why = whyNotPlausible(m);
    if (!why) { addable++; continue; }
    allResolvable = false;
    skippedBy.set(why, (skippedBy.get(why) || 0) + 1);
    if (why !== "senza presenze (vuote o 0)") onlyNoApps = false;
    if (why.startsWith("senza presenze")) {
      if (isRes) reserveSkippedNoApps++;
      if (noAppsExamples.length < 12) noAppsExamples.push(`${entry.name}: ${m.team} (${m.from}-${m.to})`);
    }
  }
  if (allResolvable) playersFullyRepaired++;
  else { playersLeftWithHoles++; if (onlyNoApps) playersLeftOnlyBecauseNoApps++; }
}

console.log(`Giocatori in fail: ${failPlayers}`);
console.log(`Tappe mancanti in totale: ${missingTotal}  (di cui squadre riserve B/C/II/III: ${reserveMissing})`);
console.log(`  aggiungibili dal rattoppo: ${addable}`);
for (const [why, n] of [...skippedBy.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  scartate - ${why}: ${n}`);
}
console.log(`     (tra le scartate senza presenze, squadre riserve: ${reserveSkippedNoApps})`);
console.log("");
console.log(`Dopo il rattoppo:`);
console.log(`  giocatori risolti del tutto (tornerebbero nel gioco): ${playersFullyRepaired}`);
console.log(`  giocatori che restano con almeno un buco (fuori dal gioco): ${playersLeftWithHoles}`);
console.log(`     di cui SOLO perché mancano le presenze su Wikipedia: ${playersLeftOnlyBecauseNoApps}`);
if (noAppsExamples.length) {
  console.log("\nEsempi di tappe scartate perché senza presenze:");
  noAppsExamples.forEach((l) => console.log("  " + l));
}
