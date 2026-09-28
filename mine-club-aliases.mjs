// Ricava dai dati (non a intuito) quali club "mancanti" sono in realtà lo
// stesso club scritto in modo diverso, e quali sono buchi veri.
//
// Uso: node mine-club-aliases.mjs [raw-players.json] [wikipedia-check.json] [quanti-club]
//
// Per ogni club che Wikipedia dà e a noi risulta mancante, guarda cosa
// abbiamo NOI per quel giocatore negli stessi anni (±1):
//  - se non abbiamo nessuna tappa in quel periodo  -> buco vero (dato assente)
//  - se abbiamo un club con nome diverso, sempre lo stesso su tanti
//    giocatori diversi                            -> quasi sicuramente un alias
import fs from "node:fs/promises";

const RAW = process.argv[2] || "./raw-players.json";
const CHECK = process.argv[3] || "./wikipedia-check.json";
const TOP = Number(process.argv[4]) || 40;

// Stessa normalizzazione di verify-against-wikipedia.mjs
const LETTER_FIXES = { "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss" };
function normClub(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[øæœłđðþß]/g, (c) => LETTER_FIXES[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));
const check = JSON.parse(await fs.readFile(CHECK, "utf-8"));
const byId = new Map((raw.players || []).map((p) => [String(p.id), p]));

const stats = new Map(); // club Wikipedia -> { cases, noData, names: Map(nostroNome -> conteggio) }
for (const [id, entry] of Object.entries(check.checked)) {
  if (entry.verdict !== "fail") continue;
  const p = byId.get(String(id));
  if (!p) continue;
  for (const m of entry.missing || []) {
    const s = stats.get(m.team) || { cases: 0, noData: 0, names: new Map() };
    s.cases++;
    // Escludiamo i blocchi "storici" già integrati da Wikipedia: hanno il
    // nome di Wikipedia per costruzione e falserebbero il confronto.
    const inRange = (p.seasonRecords || []).filter(
      (r) => r.club && r.source !== "wikipedia" && r.season >= m.from - 1 && r.season <= m.to + 1
    );
    if (inRange.length === 0) s.noData++;
    else for (const club of new Set(inRange.map((r) => r.club))) s.names.set(club, (s.names.get(club) || 0) + 1);
    stats.set(m.team, s);
  }
}

const rows = [...stats.entries()].sort((a, b) => b[1].cases - a[1].cases).slice(0, TOP);
const suggestions = [];

console.log(`Club "mancanti" più frequenti tra i fail (primi ${rows.length}):\n`);
for (const [team, s] of rows) {
  console.log(`${team}  —  ${s.cases} casi, di cui ${s.noData} senza NESSUN dato nostro in quel periodo`);
  const top3 = [...s.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [name, n] of top3) console.log(`     ${String(n).padStart(4)}/${s.cases}  ${name}`);
  const best = top3[0];
  if (best && best[1] / s.cases >= 0.5 && best[1] >= 5 && normClub(best[0]) !== normClub(team)) {
    suggestions.push(`  ["${normClub(best[0])}", "${normClub(team)}"], // ${best[0]} = ${team} (${best[1]}/${s.cases})`);
  }
}

console.log("\n" + "=".repeat(60));
if (suggestions.length === 0) {
  console.log("Nessun alias evidente (nessun nome nostro ricorre in almeno metà dei casi).");
} else {
  console.log("Alias probabili (da controllare a occhio prima di usarli):");
  console.log("Formato per CLUB_ALIASES in verify-against-wikipedia.mjs:\n");
  suggestions.forEach((l) => console.log(l));
}
