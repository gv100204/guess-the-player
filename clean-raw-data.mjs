// ---------------------------------------------------------------------------
// clean-raw-data.mjs
//
// Ripulisce raw-players.json dalle righe di carriera che il filtro ATTUALE
// (in sync-players-data.mjs) avrebbe scartato, ma che sono rimaste dentro
// perché erano state scaricate con una versione precedente del filtro,
// prima che venisse corretta.
//
// NON fa nessuna chiamata API: lavora solo su quello che è già stato
// scaricato. Controlla TUTTI i giocatori, non solo quelli con
// careerBackfilled=true: anche le righe della sola spazzolata possono
// contenere una squadra giovanile/nazionale etichettata per errore dalla
// fonte dati come campionato tracciato vero (bug reale trovato dall'audit:
// "Cesena U19" segnata come Serie A) - non bastava fidarsi del solo nome
// del campionato dichiarato.
//
// Uso:
//   node clean-raw-data.mjs raw-players.json
// Scrive un NUOVO file "raw-players.cleaned.json" accanto all'originale -
// non sovrascrive mai l'originale, per poterlo confrontare prima di usarlo.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Uso: node clean-raw-data.mjs percorso/a/raw-players.json");
  process.exit(1);
}

// ---- stessa identica logica di sync-players-data.mjs (isLikelyDomesticLeague) ----
const NON_LEAGUE_KEYWORDS = [
  "cup", "copa", "coppa", "coupe", "pokal", "beker", "taça", "taca", "champions league", "europa league", "conference league",
  "friendl", "world cup", "euro championship", "european championship", "euro -", "qualif", "super cup",
  "shield", "trophy", "community", "confederations", "nations league",
  "intercontinental", "club world cup", "youth league", "playoff", "play-off", "play off",
  "africa cup", "copa américa", "copa america", "asian cup", "gold cup", "olympic",
  "primavera", "reserve", "academy", "all-star", "all star",
  "canadian championship", "eaff e-1", "waff championship",
  "afc championship", "south american championship", "asean club championship"
];
const YOUTH_OR_NATIONAL_TEAM_PATTERN = /\bu-?(1[5-9]|2[0-3])\b/i;
const NATION_NAMES = new Set([
  "afghanistan","albania","algeria","andorra","angola","argentina","armenia","australia",
  "austria","azerbaijan","bahrain","bangladesh","belarus","belgium","belize","benin",
  "bhutan","bolivia","bosnia and herzegovina","botswana","brazil","bulgaria","burkina faso",
  "burundi","cambodia","cameroon","canada","cape verde","chad","chile","china","colombia",
  "comoros","congo","costa rica","croatia","cuba","cyprus","czech republic","denmark",
  "djibouti","dominican republic","ecuador","egypt","el salvador","england","estonia",
  "eswatini","ethiopia","fiji","finland","france","gabon","gambia","georgia","germany",
  "ghana","greece","guatemala","guinea","guyana","haiti","honduras","hungary","iceland",
  "india","indonesia","iran","iraq","ireland","israel","italy","ivory coast","jamaica",
  "japan","jordan","kazakhstan","kenya","kosovo","kuwait","kyrgyzstan","laos","latvia",
  "lebanon","lesotho","liberia","libya","liechtenstein","lithuania","luxembourg",
  "madagascar","malawi","malaysia","maldives","mali","malta","mauritania","mauritius",
  "mexico","moldova","mongolia","montenegro","morocco","mozambique","myanmar",
  "namibia","nepal","netherlands","new zealand","nicaragua","niger","nigeria",
  "north macedonia","northern ireland","norway","oman","pakistan","panama",
  "papua new guinea","paraguay","peru","philippines","poland","portugal","qatar",
  "romania","russia","rwanda","san marino","saudi arabia","scotland","senegal","serbia",
  "sierra leone","singapore","slovakia","slovenia","somalia","south africa","south korea",
  "spain","sri lanka","sudan","suriname","sweden","switzerland","syria","taiwan",
  "tajikistan","tanzania","thailand","togo","trinidad and tobago","tunisia","turkey",
  "turkmenistan","uganda","ukraine","united arab emirates","united states","uruguay",
  "uzbekistan","venezuela","vietnam","wales","yemen","zambia","zimbabwe"
]);

function isLikelyDomesticLeague(name, teamName) {
  if (!name) return false;
  if (teamName) {
    if (YOUTH_OR_NATIONAL_TEAM_PATTERN.test(teamName)) return false;
    if (NATION_NAMES.has(teamName.trim().toLowerCase())) return false;
  }
  const lower = name.toLowerCase();
  return !NON_LEAGUE_KEYWORDS.some((kw) => lower.includes(kw));
}

// Una riga di seasonRecords va ricontrollata SOLO se viene da un campionato
// NON tracciato (league === null, leagueRaw valorizzato) - le righe di un
// campionato tracciato (league === "seriea" ecc.) sono già garantite pulite
// da matchLeague, non serve ricontrollarle.
function shouldKeep(record) {
  // Il nome della squadra va controllato SEMPRE per nazionali/giovanili,
  // anche se il campionato è uno di quelli tracciati - bug reale trovato
  // dall'audit: un'apparizione di "Cesena U19" era etichettata come vera
  // Serie A dalla fonte dati stessa, e la vecchia versione si fidava
  // ciecamente di ogni riga con un campionato tracciato senza ricontrollare.
  if (YOUTH_OR_NATIONAL_TEAM_PATTERN.test(record.club || "") || NATION_NAMES.has((record.club || "").trim().toLowerCase())) {
    return false;
  }
  if (record.league) return true; // campionato tracciato, squadra verificata: pulito
  if (!record.leagueRaw) return true; // niente da verificare, lascialo
  return isLikelyDomesticLeague(record.leagueRaw, record.club);
}

async function main() {
  const raw = JSON.parse(await fs.readFile(inputPath, "utf-8"));
  const players = raw.players || [];

  let playersAffected = 0;
  let rowsRemoved = 0;
  const removedExamples = [];

  for (const p of players) {
    // NON saltiamo più i giocatori non ancora arricchiti: il controllo
    // nazionali/giovanili sul nome squadra (dentro shouldKeep) vale anche
    // per le righe della sola spazzolata - bug reale trovato dall'audit,
    // "Cesena U19" etichettata come Serie A vera dalla fonte dati stessa,
    // su un giocatore MAI arricchito dal recupero completo.
    const before = p.seasonRecords || [];
    const after = before.filter((r) => {
      const keep = shouldKeep(r);
      if (!keep) {
        rowsRemoved++;
        if (removedExamples.length < 25) {
          removedExamples.push(`${p.name} (id ${p.id}), stagione ${r.season}: "${r.club}" - ${r.leagueRaw}`);
        }
      }
      return keep;
    });
    if (after.length !== before.length) {
      playersAffected++;
      p.seasonRecords = after;
    }
  }

  console.log(`Giocatori toccati: ${playersAffected.toLocaleString("it-IT")}`);
  console.log(`Righe rimosse in totale: ${rowsRemoved.toLocaleString("it-IT")}`);
  console.log();
  if (removedExamples.length > 0) {
    console.log("Esempi di righe rimosse:");
    removedExamples.forEach((e) => console.log(`  - ${e}`));
    if (rowsRemoved > removedExamples.length) {
      console.log(`  ... e altre ${rowsRemoved - removedExamples.length}`);
    }
  }

  const dir = path.dirname(inputPath);
  const outPath = path.join(dir, "raw-players.cleaned.json");
  await fs.writeFile(outPath, JSON.stringify(raw, null, 2), "utf-8");
  console.log();
  console.log(`Scritto: ${outPath}`);
  console.log("L'originale NON è stato toccato. Controlla il nuovo file, poi se va bene");
  console.log("rinominalo/sostituiscilo tu stesso a raw-players.json prima del prossimo sync.");
}

main();
