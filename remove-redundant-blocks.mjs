// Toglie i blocchi storici (source: "wikipedia") che sono RIDONDANTI: lo
// stesso club, con dati normali (stagione per stagione, più precisi) che
// già coprono l'inizio e la fine dell'intervallo dichiarato dal blocco.
// Questi blocchi sono stati scritti PRIMA della correzione di isCovered
// (quella per Abbiati) - con la regola attuale non verrebbero più
// aggiunti, ma quelli già scritti restano sbagliati finché non li
// togliamo a mano. Caso reale trovato: Stefano Moreo, "Virtus Entella
// 2013-2015" (blocco, 34 presenze) ridondante con i dati normali già
// precisi (24 presenze 2013, 10 presenze 2014).
//
// SICURO DI DEFAULT: senza --apply mostra solo cosa farebbe.
//
// Uso:
//   node remove-redundant-blocks.mjs                    -> anteprima
//   node remove-redundant-blocks.mjs raw-players.json --apply
import fs from "node:fs/promises";

const RAW = process.argv.find((a) => a.endsWith(".json")) || "./raw-players.json";
const APPLY = process.argv.includes("--apply");

const CLUB_ALIASES = new Map([
  ["qpr", "queens park rangers"], ["bayern munchen", "bayern munich"],
  ["wolves", "wolverhampton wanderers"], ["olympiakos piraeus", "olympiacos"],
  ["athletic club", "athletic bilbao"], ["vitoria sc", "vitoria guimaraes"],
  ["sheffield utd", "sheffield united"], ["atletico mg", "atletico mineiro"],
  ["tsv 1860 munchen", "1860 munich"], ["1899 hoffenheim", "tsg hoffenheim"],
  ["sparta praha", "sparta prague"], ["fk crvena zvezda", "red star belgrade"],
  ["cfr 1907 cluj", "cfr cluj"], ["uniao de leiria", "uniao leiria"],
  ["legia warszawa", "legia warsaw"], ["los angeles galaxy", "la galaxy"],
  ["athletic club ii", "bilbao athletic"], ["celta de vigo ii", "celta ii"],
  ["pacos ferreira", "pacos de ferreira"], ["bayern munchen ii", "bayern munich ii"],
  ["olympique lyonnais ii", "lyon b"], ["gazelec fc ajaccio", "gazelec ajaccio"],
  ["st truiden", "sint truiden"], ["atletico paranaense", "athletico paranaense"],
  ["psg ii", "paris saint germain b"], ["borussia mgladbach ii", "borussia monchengladbach ii"],
  ["sevilla atletico", "sevilla b"], ["vitoria de guimaraes", "vitoria guimaraes"],
  ["slavia praha", "slavia prague"], ["austria vienna", "austria wien"],
  ["rapid vienna", "rapid wien"], ["u madeira", "uniao madeira"],
  ["el mokawloon", "al mokawloon"], ["universidad catolica", "u catolica"],
  ["club libertad", "libertad asuncion"], ["argentinos jrs", "argentinos juniors"],
  ["uanl", "tigres uanl"]
]);
const LETTER_FIXES = { "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss" };
function normClub(s) {
  let base = (s || "").toLowerCase()
    .replace(/[øæœłđðþß]/g, (c) => LETTER_FIXES[c])
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  base = base.replace(/ b$/, " ii");
  return CLUB_ALIASES.get(base) || base;
}

const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));
let playersAffected = 0;
let blocksRemoved = 0;
const examples = [];

for (const p of raw.players) {
  const records = p.seasonRecords || [];
  const toRemove = new Set();

  records.forEach((block, i) => {
    if (block.source !== "wikipedia" || block.blockToYear == null) return;
    const from = block.season, to = block.blockToYear;
    const hasNear = (year) => records.some((r) =>
      r.source !== "wikipedia" && normClub(r.club) === normClub(block.club) && Math.abs(r.season - year) <= 1
    );
    if (hasNear(from) && hasNear(to)) toRemove.add(i);
  });

  if (toRemove.size > 0) {
    playersAffected++;
    blocksRemoved += toRemove.size;
    if (examples.length < 20) {
      examples.push(`${p.name}: ${[...toRemove].map((i) => `${records[i].club} (${records[i].season}-${records[i].blockToYear})`).join(", ")}`);
    }
    if (APPLY) p.seasonRecords = records.filter((_, idx) => !toRemove.has(idx));
  }
}

console.log(`Giocatori con blocchi ridondanti: ${playersAffected}`);
console.log(`Blocchi che verrebbero tolti: ${blocksRemoved}`);
console.log(`\nPrimi esempi:`);
examples.forEach((e) => console.log(`  ${e}`));

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node remove-redundant-blocks.mjs raw-players.json --apply");
} else {
  await fs.copyFile(RAW, RAW.replace(/\.json$/, "") + ".prima-rimozione-ridondanti.json").catch(() => {});
  await fs.writeFile(RAW, JSON.stringify(raw), "utf-8");
  console.log(`\nScritto direttamente in ${RAW}. Copia di sicurezza salvata accanto.`);
}
