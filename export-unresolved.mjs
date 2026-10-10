// Elenca i giocatori che la scansione non riesce a risolvere e prepara
// wikipedia-manual-links.json da compilare a mano.
// Uso: node export-unresolved.mjs
// Poi apri da-cercare.txt, trova le pagine, incolla gli URL (o i titoli)
// nel JSON accanto all'id giusto, e lancia: node verify-against-wikipedia.mjs all
import fs from "node:fs/promises";

const unresolved = JSON.parse(await fs.readFile("./wikipedia-unresolved.json", "utf-8")).unresolved || {};
const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));
const byId = new Map((raw.players || []).map((p) => [String(p.id), p]));
let manual = {};
try { manual = JSON.parse(await fs.readFile("./wikipedia-manual-links.json", "utf-8")); } catch {}

const lines = [];
for (const [id, u] of Object.entries(unresolved)) {
  if (manual[id]) continue; // già compilato
  const p = byId.get(String(id));
  if (!p) continue;
  const clubs = [...new Set((p.seasonRecords || []).map((r) => r.club))].slice(0, 6).join(", ");
  lines.push(`${id} | ${u.name} | nato ${u.birthYear ?? "?"} | ${u.nationality ?? "?"} | ${clubs}`);
  manual[id] = "";
}
await fs.writeFile("./da-cercare.txt", lines.join("\n") + "\n", "utf-8");
await fs.writeFile("./wikipedia-manual-links.json", JSON.stringify(manual, null, 2), "utf-8");
console.log(`${lines.length} giocatori da cercare a mano -> da-cercare.txt`);
console.log(`Compila i valori vuoti in wikipedia-manual-links.json (URL o titolo Wikipedia). I vuoti vengono ignorati.`);
