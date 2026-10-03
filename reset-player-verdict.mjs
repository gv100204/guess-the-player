// Toglie il verdetto Wikipedia salvato (e la carriera salvata, se c'è) per
// uno o più giocatori specifici, cercati per nome - così la prossima
// scansione (node verify-against-wikipedia.mjs all) li ricontrolla da
// zero con la logica attuale, invece di fidarsi di un verdetto vecchio
// che potrebbe essere sbagliato per un bug già corretto nel frattempo.
//
// Uso: node reset-player-verdict.mjs "Memushaj" ["Altro Nome" ...]
import fs from "node:fs/promises";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.log('Uso: node reset-player-verdict.mjs "Nome Cognome" ["Altro Nome" ...]');
  process.exit(1);
}

const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));
const check = JSON.parse(await fs.readFile("./wikipedia-check.json", "utf-8"));

let careersText = "";
try { careersText = await fs.readFile("./wikipedia-careers.jsonl", "utf-8"); } catch {}

const matchedIds = new Set();
for (const n of names) {
  const found = raw.players.filter((p) => p.name.toLowerCase().includes(n.toLowerCase()));
  if (found.length === 0) console.log(`Nessun giocatore trovato per "${n}"`);
  found.forEach((p) => {
    matchedIds.add(String(p.id));
    console.log(`Trovato: ${p.name} (id ${p.id})`);
  });
}

let removedVerdicts = 0;
for (const id of matchedIds) {
  if (check.checked[id]) {
    delete check.checked[id];
    removedVerdicts++;
  }
}

let removedCareers = 0;
const keptLines = careersText.split("\n").filter((line) => {
  if (!line.trim()) return true;
  try {
    const rec = JSON.parse(line);
    if (matchedIds.has(String(rec.id))) { removedCareers++; return false; }
  } catch {}
  return true;
});

await fs.writeFile("./wikipedia-check.json", JSON.stringify(check), "utf-8");
if (careersText) await fs.writeFile("./wikipedia-careers.jsonl", keptLines.join("\n"), "utf-8");

console.log(`\nVerdetti tolti: ${removedVerdicts}`);
console.log(`Carriere salvate tolte: ${removedCareers}`);
console.log(`\nLa prossima scansione (node verify-against-wikipedia.mjs all) li ricontrollerà da zero.`);
