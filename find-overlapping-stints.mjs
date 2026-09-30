// Trova i giocatori le cui tappe si sovrappongono nel tempo (stesso anno,
// due club diversi) - il sintomo esatto del bug dei prestiti dentro un
// blocco storico. Non tocca Wikipedia, legge solo raw-players.json.
//
// Uso: node find-overlapping-stints.mjs [raw-players.json]
import fs from "node:fs/promises";

// Stessa normalizzazione usata in verify-against-wikipedia.mjs - senza
// questa, club scritti diverso (Atletico/Athletico Paranaense, El/Al-
// Mokawloon...) risultano "diversi" per errore e gonfiano il conteggio.
const CLUB_ALIASES = new Map([
  ["qpr", "queens park rangers"],
  ["bayern munchen", "bayern munich"],
  ["wolves", "wolverhampton wanderers"],
  ["olympiakos piraeus", "olympiacos"],
  ["athletic club", "athletic bilbao"],
  ["vitoria sc", "vitoria guimaraes"],
  ["sheffield utd", "sheffield united"],
  ["atletico mg", "atletico mineiro"],
  ["tsv 1860 munchen", "1860 munich"],
  ["1899 hoffenheim", "tsg hoffenheim"],
  ["sparta praha", "sparta prague"],
  ["fk crvena zvezda", "red star belgrade"],
  ["cfr 1907 cluj", "cfr cluj"],
  ["uniao de leiria", "uniao leiria"],
  ["legia warszawa", "legia warsaw"],
  ["los angeles galaxy", "la galaxy"],
  ["athletic club ii", "bilbao athletic"],
  ["celta de vigo ii", "celta ii"],
  ["pacos ferreira", "pacos de ferreira"],
  ["bayern munchen ii", "bayern munich ii"],
  ["olympique lyonnais ii", "lyon b"],
  ["gazelec fc ajaccio", "gazelec ajaccio"],
  ["st truiden", "sint truiden"],
  ["atletico paranaense", "athletico paranaense"],
  ["psg ii", "paris saint germain b"],
  ["borussia mgladbach ii", "borussia monchengladbach ii"],
  ["sevilla atletico", "sevilla b"],
  ["vitoria de guimaraes", "vitoria guimaraes"],
  ["slavia praha", "slavia prague"],
  ["austria vienna", "austria wien"],
  ["rapid vienna", "rapid wien"],
  ["u madeira", "uniao madeira"],
  // Trovati da questo controllo, non ancora nella lista principale -
  // spelling diversi dello stesso club, non due club diversi:
  ["el mokawloon", "al mokawloon"],
  ["universidad catolica", "u catolica"],
  ["club libertad", "libertad asuncion"]
]);
const LETTER_FIXES = { "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss" };
function normClub(s) {
  let base = (s || "")
    .toLowerCase()
    .replace(/[øæœłđðþß]/g, (c) => LETTER_FIXES[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  base = base.replace(/ b$/, " ii");
  return CLUB_ALIASES.get(base) || base;
}

const RAW = process.argv[2] || "./raw-players.json";
const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));

let found = 0;
const examples = [];

for (const p of raw.players) {
  const records = (p.seasonRecords || []).filter((r) => r.club);
  // Raggruppiamo per intervallo effettivo: per ogni tappa, servono
  // from/to. I dati normali sono per singola stagione (from=to=season),
  // i blocchi storici hanno from/to espliciti su piu' anni.
  const spans = records.map((r) => ({
    club: r.club,
    from: r.season,
    to: r.blockToYear ?? r.season,
    isHistoric: r.source === "wikipedia"
  }));

  let overlap = null;
  for (let i = 0; i < spans.length && !overlap; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      if (normClub(a.club) === normClub(b.club)) continue;
      const overlapsInTime = a.from < b.to && b.from < a.to; // rigoroso: toccarsi solo sul confine non conta
      if (overlapsInTime && (a.isHistoric || b.isHistoric)) {
        overlap = [a, b];
        break;
      }
    }
  }

  if (overlap) {
    found++;
    if (examples.length < 20) {
      examples.push(`${p.name}: ${overlap[0].club} (${overlap[0].from}-${overlap[0].to}) vs ${overlap[1].club} (${overlap[1].from}-${overlap[1].to})`);
    }
  }
}

console.log(`Giocatori con tappe sovrapposte (almeno una storica): ${found}`);
console.log(`\nPrimi esempi:`);
examples.forEach((e) => console.log(`  ${e}`));
