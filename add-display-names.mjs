// Aggiunge un campo "displayName" a ogni giocatore per cui abbiamo una
// carriera Wikipedia salvata (wikipedia-careers.jsonl): il nome "pubblico"
// con cui è conosciuto (es. "Barreto", "Pepe Reina", "Stelios Malezas"),
// preso dal titolo della pagina Wikipedia trovata - non tocca le carriere,
// solo aggiunge questo campo. Chi non ha una carriera Wikipedia salvata
// resta con il proprio "name" originale (nessun cambiamento).
//
// Uso: node add-display-names.mjs [raw-players.json] [wikipedia-careers.jsonl]
import fs from "node:fs/promises";

const RAW = process.argv[2] || "./raw-players.json";
const CAREERS = process.argv[3] || "./wikipedia-careers.jsonl";

// Il titolo Wikipedia a volte ha un disambiguante attaccato
// ("Barreto (footballer, born 1985)", "Diego Godín (footballer)"): lo
// nome pubblico è solo la parte prima della parentesi.
function toDisplayName(wikipediaTitle) {
  return wikipediaTitle.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));
const byId = new Map(raw.players.map((p) => [String(p.id), p]));

const careersText = await fs.readFile(CAREERS, "utf-8");
let updated = 0, skippedNoPlayer = 0, unchanged = 0;
const examples = [];

for (const line of careersText.split("\n")) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue; // riga troncata, la ignoriamo
  }
  const p = byId.get(String(rec.id));
  if (!p) {
    skippedNoPlayer++;
    continue;
  }
  const displayName = toDisplayName(rec.wikipediaTitle);
  if (p.displayName === displayName) {
    unchanged++;
    continue;
  }
  if (examples.length < 15 && displayName !== p.name) {
    examples.push(`${p.name}  ->  ${displayName}`);
  }
  p.displayName = displayName;
  updated++;
}

await fs.writeFile(RAW, JSON.stringify(raw), "utf-8");

console.log(`Giocatori aggiornati con displayName: ${updated}`);
console.log(`Già uguali (nessun cambiamento): ${unchanged}`);
if (skippedNoPlayer) console.log(`Righe di wikipedia-careers.jsonl senza giocatore corrispondente: ${skippedNoPlayer}`);
console.log(`\nPrimi esempi di nome cambiato:`);
examples.forEach((e) => console.log(`  ${e}`));
