// Toglie da wikipedia-check.json i verdetti "ok" dei giocatori che NON
// hanno una carriera salvata in wikipedia-careers.jsonl (controllati prima
// che iniziassimo a salvarla). Senza carriera salvata non esiste il titolo
// della pagina Wikipedia, quindi add-display-names.mjs non può ricavare il
// nome pubblico (es. "Juan" per Juan Silveira dos Santos). Rilanciando poi
// "node verify-against-wikipedia.mjs all" vengono ricontrollati e salvati.
//
// Tocca SOLO i verdetti "ok", mai i "fail": togliere un "fail" farebbe
// rientrare nel gioco, fino al ricontrollo, un giocatore escluso per
// carriera incompleta. Un giocatore senza verdetto non viene escluso, quindi
// togliere un "ok" non lo fa uscire dal gioco.
//
// SICURO DI DEFAULT: senza --apply mostra solo cosa farebbe.
//
// Uso:
//   node reset-ok-without-career.mjs
//   node reset-ok-without-career.mjs --apply
import fs from "node:fs/promises";

const APPLY = process.argv.includes("--apply");

const check = JSON.parse(await fs.readFile("./wikipedia-check.json", "utf-8"));
const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));
const rawIds = new Set(raw.players.map((p) => String(p.id)));

let careersText = "";
try { careersText = await fs.readFile("./wikipedia-careers.jsonl", "utf-8"); } catch {}
const careerIds = new Set();
careersText.split("\n").forEach((line) => {
  if (!line.trim()) return;
  try { careerIds.add(String(JSON.parse(line).id)); } catch {}
});

const toReset = [];
for (const [id, v] of Object.entries(check.checked)) {
  if (v.verdict !== "ok") continue;
  if (!rawIds.has(String(id))) continue; // non più nei dati: lo lasciamo stare
  if (careerIds.has(String(id))) continue; // ha già la carriera salvata
  toReset.push({ id, name: v.name });
}

console.log(`Verdetti "ok" totali: ${Object.values(check.checked).filter((v) => v.verdict === "ok").length}`);
console.log(`Con carriera già salvata (non toccati): ${careerIds.size}`);
console.log(`"ok" senza carriera salvata, da ricontrollare: ${toReset.length}`);
const seconds = toReset.length * 5;
console.log(`Tempo stimato di scansione: circa ${Math.round(seconds / 3600 * 10) / 10} ore (si può fermare con Ctrl+C e riprendere)`);
console.log("\nPrimi esempi:");
toReset.slice(0, 10).forEach((e) => console.log(`  ${e.name}`));

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node reset-ok-without-career.mjs --apply");
} else {
  await fs.copyFile("./wikipedia-check.json", "./wikipedia-check.backup-reset-ok.json");
  for (const e of toReset) delete check.checked[e.id];
  await fs.writeFile("./wikipedia-check.json", JSON.stringify(check), "utf-8");
  console.log(`\nTolti ${toReset.length} verdetti. Copia di sicurezza: wikipedia-check.backup-reset-ok.json (non va aggiunta a Git).`);
  console.log("Ora lancia: node verify-against-wikipedia.mjs all");
}
