// Toglie da raw-players.json SOLO i blocchi storici (source: "wikipedia")
// che si sovrappongono nel tempo con un'altra tappa di un club diverso -
// lo stesso identificato da find-overlapping-stints.mjs. Non tocca nulla
// altro: le tappe normali restano, i blocchi storici SENZA conflitti
// restano. Dopo aver tolto quelli sovrapposti, rilanciando
// apply-wikipedia-fills.mjs vengono riscritti da capo, stavolta con il
// taglio automatico.
//
// SICURO DI DEFAULT: senza --apply mostra solo cosa farebbe.
//
// Uso:
//   node remove-overlapping-blocks.mjs                    -> anteprima
//   node remove-overlapping-blocks.mjs --apply             -> applica davvero
import fs from "node:fs/promises";

const RAW = process.argv.find((a) => a.endsWith(".json") && !a.includes("check")) || "./raw-players.json";
const APPLY = process.argv.includes("--apply");

// Stessa normalizzazione usata altrove.
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
  ["club libertad", "libertad asuncion"]
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
  const spans = records.map((r) => ({
    ref: r,
    club: r.club,
    from: r.season,
    to: r.blockToYear ?? r.season
  }));

  const toRemove = new Set();
  for (let i = 0; i < spans.length; i++) {
    const a = spans[i];
    if (a.ref.source !== "wikipedia") continue; // tocchiamo solo i blocchi storici, mai i dati normali
    for (let j = 0; j < spans.length; j++) {
      if (i === j) continue;
      const b = spans[j];
      if (normClub(a.club) === normClub(b.club)) continue;
      const overlaps = a.from < b.to && b.from < a.to;
      if (overlaps) { toRemove.add(i); break; }
    }
  }

  if (toRemove.size > 0) {
    playersAffected++;
    blocksRemoved += toRemove.size;
    if (examples.length < 15) {
      examples.push(`${p.name}: tolti ${[...toRemove].map((i) => `${spans[i].club} (${spans[i].from}-${spans[i].to})`).join(", ")}`);
    }
    if (APPLY) {
      p.seasonRecords = records.filter((_, idx) => !toRemove.has(idx));
    }
  }
}

console.log(`Giocatori con blocchi storici sovrapposti: ${playersAffected}`);
console.log(`Blocchi che verrebbero tolti: ${blocksRemoved}`);
console.log(`\nPrimi esempi:`);
examples.forEach((e) => console.log(`  ${e}`));

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node remove-overlapping-blocks.mjs raw-players.json --apply");
} else {
  await fs.copyFile(RAW, RAW.replace(/\.json$/, "") + ".prima-rimozione-sovrapposti.json").catch(() => {});
  await fs.writeFile(RAW, JSON.stringify(raw), "utf-8");
  console.log(`\nScritto direttamente in ${RAW}. Copia di sicurezza salvata accanto.`);
  console.log("Ora rilancia: node apply-wikipedia-fills.mjs raw-players.json wikipedia-check.json");
}
