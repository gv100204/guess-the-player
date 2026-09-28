// Toglie da wikipedia-check.json i verdetti "fail al 100% mancante": cioè i
// giocatori per cui NESSUNA delle tappe di Wikipedia combacia con le nostre.
// Nella grande maggioranza dei casi vuol dire che era stata trovata la
// persona sbagliata (un omonimo, un nome simile: es. "José" -> "Josue"),
// non che la carriera fosse tutta mancante. Tolti dal file, tornano
// "da controllare" e la prossima scansione li rifà con le regole attuali.
//
// SICURO DI DEFAULT: senza --apply mostra soltanto cosa farebbe.
//
// Uso:
//   node reset-full-mismatch.mjs            -> solo anteprima, non scrive nulla
//   node reset-full-mismatch.mjs --apply    -> fa una copia di sicurezza e poi toglie
//
// Nota: qualche caso al 100% è genuino (es. un giocatore con una sola tappa
// su Wikipedia): verrà semplicemente ricontrollato e otterrà lo stesso
// verdetto. Costa tempo di scansione, non fa danni.
import fs from "node:fs/promises";

const CHECK = "./wikipedia-check.json";
const APPLY = process.argv.includes("--apply");

const data = JSON.parse(await fs.readFile(CHECK, "utf-8"));
const ids = Object.keys(data.checked);
const suspects = ids.filter((id) => data.checked[id].verdict === "fail" && data.checked[id].missingFraction === 1);

console.log(`Verdetti nel file: ${ids.length}`);
console.log(`Fail al 100% mancante (probabile persona sbagliata): ${suspects.length}`);
console.log("\nPrimi 15 esempi (nostro nome -> pagina Wikipedia trovata):");
suspects.slice(0, 15).forEach((id) => {
  const e = data.checked[id];
  console.log(`  ${e.name}  ->  ${e.wikipediaTitle}`);
});

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node reset-full-mismatch.mjs --apply");
} else {
  await fs.copyFile(CHECK, "./wikipedia-check.prima-reset.json");
  for (const id of suspects) delete data.checked[id];
  await fs.writeFile(CHECK, JSON.stringify(data, null, 2), "utf-8");
  console.log(`\nRimossi ${suspects.length} verdetti. Rimasti: ${Object.keys(data.checked).length}`);
  console.log("Copia di sicurezza: ./wikipedia-check.prima-reset.json");
  console.log("Ora rilancia: node verify-against-wikipedia.mjs all   (li rifà da capo)");
}
