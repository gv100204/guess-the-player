// ---------------------------------------------------------------------------
// audit-raw-data.mjs
//
// A DIFFERENZA dei test in test-sync-players-data.mjs (che verificano la
// LOGICA del codice con dati finti), questo script controlla i DATI VERI
// già scaricati in raw-players.json, alla ricerca di anomalie che i test
// non possono vedere - perché un test verifica "il codice fa quello che
// deve con l'input che gli do", non "il codice ha già prodotto dati puliti
// su 22.000 giocatori veri".
//
// Uso:
//   node audit-raw-data.mjs [percorso/a/raw-players.json]
// Se non specifichi un percorso, cerca raw-players.json nella cartella
// corrente.
//
// Non modifica nulla: stampa solo un rapporto. Non serve una chiave API,
// non fa nessuna chiamata di rete - lavora solo su quello che hai già.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";

const filePath = process.argv[2] || "./raw-players.json";

// Stessa lista di nazioni usata in sync-players-data.mjs: se una "squadra"
// coincide esattamente con un nome di paese, non è mai un club vero - è
// quasi certamente una nazionale (anche di un torneo/amichevole mai visto
// prima, che nessuna parola chiave potrebbe coprire in anticipo).
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
const YOUTH_PATTERN = /\bu-?(1[5-9]|2[0-3])\b/i;

// Parole chiave "sospette" più AMPIE di quelle usate nel filtro vero e
// proprio (isLikelyDomesticLeague) - qui vogliamo essere permissivi e
// segnalare anche falsi sospetti, per farli guardare a un umano, non per
// scartare automaticamente. Meglio un falso allarme in più che un bug
// invisibile in meno.
const SUSPECT_KEYWORDS = [
  "cup", "copa", "coppa", "championship", "trophy", "shield", "friendl",
  "qualif", "playoff", "play-off", "play off", "olympic", "invitational",
  "confederations", "nations league", "youth", "reserve", "primavera",
  "b team", " b)", "regional", "exhibition", "all-star", "all star"
];

function isSuspectLeagueName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return SUSPECT_KEYWORDS.some((kw) => lower.includes(kw));
}

async function main() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch (err) {
    console.error(`Non riesco a leggere ${filePath}: ${err.message}`);
    console.error("Uso: node audit-raw-data.mjs [percorso/a/raw-players.json]");
    process.exit(1);
  }

  const players = raw.players || [];
  console.log(`Controllo ${players.length.toLocaleString("it-IT")} giocatori da ${filePath}...\n`);

  // ---- 1. Squadre che coincidono con un nome di nazione (maggiore o giovanile) ----
  const nationLeaks = [];
  for (const p of players) {
    for (const r of p.seasonRecords || []) {
      const club = (r.club || "").trim();
      const isNation = NATION_NAMES.has(club.toLowerCase()) || YOUTH_PATTERN.test(club);
      if (isNation) {
        nationLeaks.push({ player: p.name, id: p.id, season: r.season, club: r.club, league: r.leagueRaw || r.league });
      }
    }
  }

  console.log(`1) Presenze in nazionale finite nella carriera come se fossero un club: ${nationLeaks.length}`);
  if (nationLeaks.length > 0) {
    console.log("   (dovrebbero essere ZERO - se ne trovi, è il bug delle nazionali non ancora coperto del tutto)");
    nationLeaks.slice(0, 20).forEach((l) => {
      console.log(`   - ${l.player} (id ${l.id}), stagione ${l.season}: "${l.club}" - ${l.league}`);
    });
    if (nationLeaks.length > 20) console.log(`   ... e altri ${nationLeaks.length - 20}`);
  }
  console.log();

  // ---- 2. Nomi di campionato "fuori catalogo" con parole sospette ----
  // Solo per i campionati NON tracciati (league === null, leagueRaw valorizzato):
  // se il nome grezzo contiene una parola sospetta, potrebbe essere una coppa
  // o una competizione che il filtro vero (più severo, meno parole) non ha
  // ancora imparato a riconoscere.
  const suspectLeagueNames = new Map(); // nome -> {count, esempioGiocatore}
  for (const p of players) {
    for (const r of p.seasonRecords || []) {
      if (r.league) continue; // campionato tracciato, non ci interessa qui
      if (!r.leagueRaw) continue;
      if (isSuspectLeagueName(r.leagueRaw)) {
        const key = r.leagueRaw + " (" + (r.country || "?") + ")";
        if (!suspectLeagueNames.has(key)) suspectLeagueNames.set(key, { count: 0, esempio: p.name });
        suspectLeagueNames.get(key).count++;
      }
    }
  }

  console.log(`2) Nomi di competizione fuori catalogo con parole sospette (coppe/tornei/nazionali): ${suspectLeagueNames.size} nomi distinti`);
  if (suspectLeagueNames.size > 0) {
    console.log("   (da controllare a occhio: magari sono coppe vere che il filtro dovrebbe già scartare ma non lo fa)");
    Array.from(suspectLeagueNames.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30)
      .forEach(([name, info]) => {
        console.log(`   - "${name}" - ${info.count} presenze (es. ${info.esempio})`);
      });
  }
  console.log();

  // ---- 3. Tutti i nomi di competizione fuori catalogo, senza filtro ----
  // Utile per una scorsa manuale una tantum: qualunque cosa suoni strana qui,
  // anche senza contenere una delle parole sospette sopra, vale la pena
  // guardarla - è la lista COMPLETA di tutto quello che abbiamo catturato
  // come "fuori dai 6 campionati tracciati".
  const allRawLeagues = new Map();
  for (const p of players) {
    for (const r of p.seasonRecords || []) {
      if (r.league || !r.leagueRaw) continue;
      const key = r.leagueRaw + " (" + (r.country || "?") + ")";
      allRawLeagues.set(key, (allRawLeagues.get(key) || 0) + 1);
    }
  }
  console.log(`3) Totale nomi di competizione distinti fuori catalogo: ${allRawLeagues.size}`);
  console.log("   (salvati in audit-raw-leagues.txt per una scorsa manuale completa, non stampati tutti qui)");
  const sortedLeagues = Array.from(allRawLeagues.entries()).sort((a, b) => b[1] - a[1]);
  await fs.writeFile(
    "./audit-raw-leagues.txt",
    sortedLeagues.map(([name, count]) => `${count}\t${name}`).join("\n"),
    "utf-8"
  );
  console.log();

  // ---- 4. Presenze implausibili in una singola stagione ----
  // Un campionato reale ha al massimo ~38-46 giornate: più di 60 presenze in
  // una singola stagione/club/campionato è quasi certamente un doppio
  // conteggio (due fonti sommate per errore), non un dato vero.
  const IMPLAUSIBLE_APPS_THRESHOLD = 60;
  const implausible = [];
  for (const p of players) {
    for (const r of p.seasonRecords || []) {
      if (r.apps > IMPLAUSIBLE_APPS_THRESHOLD) {
        implausible.push({ player: p.name, id: p.id, season: r.season, club: r.club, apps: r.apps });
      }
    }
  }
  console.log(`4) Righe con presenze implausibili (oltre ${IMPLAUSIBLE_APPS_THRESHOLD} in una stagione, possibile doppio conteggio): ${implausible.length}`);
  implausible.slice(0, 20).forEach((l) => {
    console.log(`   - ${l.player} (id ${l.id}), stagione ${l.season}, ${l.club}: ${l.apps} presenze`);
  });
  if (implausible.length > 20) console.log(`   ... e altri ${implausible.length - 20}`);
  console.log();

  // ---- 5. Nomi ancora nella forma abbreviata ("X. Cognome") ----
  // Il fix per il nome per esteso si autocorregge solo quando l'API fornisce
  // firstname/lastname - per alcuni giocatori potrebbe non essere mai
  // arrivato. Segnaliamo chi è rimasto abbreviato, per sapere quanti sono.
  const ABBREVIATED_NAME_PATTERN = /^[A-ZÀ-Ý]\.\s?\S/;
  const stillAbbreviated = players.filter((p) => ABBREVIATED_NAME_PATTERN.test(p.name));
  console.log(`5) Giocatori il cui nome è ancora nella forma abbreviata ("X. Cognome"): ${stillAbbreviated.length}`);
  console.log("   (limite noto della fonte dati, non un bug nostro - solo per sapere quanti sono)");
  stillAbbreviated.slice(0, 10).forEach((p) => console.log(`   - ${p.name} (id ${p.id})`));
  if (stillAbbreviated.length > 10) console.log(`   ... e altri ${stillAbbreviated.length - 10}`);
  console.log();

  // ---- Riepilogo ----
  const problemi = nationLeaks.length + implausible.length;
  console.log("=".repeat(60));
  if (problemi === 0) {
    console.log("Nessuna anomalia CERTA trovata (punti 1 e 4). Punti 2, 3 e 5 sono da");
    console.log("scorrere a occhio: non sono errori sicuri, solo cose da controllare.");
  } else {
    console.log(`Trovate ${problemi} anomalie CERTE da correggere (punti 1 e 4 sopra).`);
  }
}

main();
