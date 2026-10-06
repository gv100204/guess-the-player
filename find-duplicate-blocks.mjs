// Cerca i blocchi storici (source: "wikipedia") DUPLICATI dentro
// raw-players.json: stesso club, stessi anni, ripetuti. In uscita
// (dedupedSeasonRecords) due blocchi identici si fondono SOMMANDO le presenze,
// quindi la tappa mostrerebbe presenze raddoppiate. Succedeva rilanciando
// apply-wikipedia-fills.mjs sui blocchi già tagliati (bug corretto).
//
// Toglie SOLO i doppioni identici (tiene il primo). I blocchi che si
// sovrappongono senza essere identici vengono solo segnalati, mai toccati.
//
// SICURO DI DEFAULT: senza --apply non scrive nulla.
// Uso:
//   node find-duplicate-blocks.mjs
//   node find-duplicate-blocks.mjs --apply
import fs from "node:fs/promises";

const APPLY = process.argv.includes("--apply");
const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));

let playersWithIdentical = 0, identicalRemoved = 0, playersWithOverlap = 0;
const examples = [], overlapExamples = [];

for (const p of raw.players) {
  const records = p.seasonRecords || [];
  const seen = new Set();
  const keep = [];
  let removedHere = 0;
  for (const r of records) {
    if (r.blockToYear != null && r.source === "wikipedia") {
      const key = `${r.club}|${r.season}|${r.blockToYear}`;
      if (seen.has(key)) { removedHere++; continue; }
      seen.add(key);
    }
    keep.push(r);
  }
  if (removedHere > 0) {
    playersWithIdentical++;
    identicalRemoved += removedHere;
    if (examples.length < 10) examples.push(`${p.name} (${removedHere})`);
    if (APPLY) p.seasonRecords = keep;
  }

  // blocchi dello stesso club che si sovrappongono senza essere identici
  const blocks = keep.filter((r) => r.blockToYear != null && r.source === "wikipedia");
  let overlapHere = false;
  for (let i = 0; i < blocks.length && !overlapHere; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.club !== b.club) continue;
      if (Math.min(a.blockToYear, b.blockToYear) - Math.max(a.season, b.season) > 0) { overlapHere = true; break; }
    }
  }
  if (overlapHere) {
    playersWithOverlap++;
    if (overlapExamples.length < 10) overlapExamples.push(p.name);
  }
}

console.log(`Giocatori con blocchi IDENTICI duplicati: ${playersWithIdentical} (blocchi in eccesso: ${identicalRemoved})`);
examples.forEach((e) => console.log(`   ${e}`));
console.log(`\nGiocatori con blocchi dello stesso club che si sovrappongono (non identici, non toccati): ${playersWithOverlap}`);
overlapExamples.forEach((e) => console.log(`   ${e}`));

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node find-duplicate-blocks.mjs --apply");
} else {
  await fs.copyFile("./raw-players.json", "./raw-players.prima-doppioni.json");
  await fs.writeFile("./raw-players.json", JSON.stringify(raw), "utf-8");
  console.log("\nScritto in raw-players.json. Copia di sicurezza: raw-players.prima-doppioni.json (non va aggiunta a Git).");
}
