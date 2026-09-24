/**
 * sync-players-data.mjs
 * ----------------------------------------------------------------------------
 * Script di sincronizzazione (da eseguire su un server / cron job, MAI sul
 * telefono): NON parte da una lista di nomi da cercare (fragile: omonimi,
 * apostrofi, giocatori non trovati). Parte invece dai CAMPIONATI: per ogni
 * campionato e stagione scelti, chiede ad API-Football "chi ha giocato qui",
 * pagina per pagina - ogni giocatore arriva già con un ID certo dell'API,
 * senza bisogno di indovinare chi sia.
 *
 * Produce, dentro ./output/:
 *   - players-data.json   tutti i giocatori sopra la soglia minima, file unico
 *   - <campionato>.json   uno shard per campionato (contiene la scheda
 *                         COMPLETA di ogni giocatore, non solo la parte
 *                         relativa a quel campionato)
 *   - manifest.json       elenco degli shard con versione e conteggio
 *
 * E, nella cartella principale (da COMMITTARE, non solo da pubblicare):
 *   - raw-players.json    tutti i dati grezzi accumulati finora (persistono
 *                         tra un run e l'altro)
 *   - sync-progress.json  quali coppie campionato/stagione sono già state
 *                         spazzolate, per non ripartire da zero ogni volta
 *
 * Uso:
 *   API_FOOTBALL_KEY=xxxxx node sync-players-data.mjs
 *
 * Richiede Node 18+ (usa il fetch nativo). Nessuna dipendenza esterna.
 *
 * IMPORTANTE - gestione della quota:
 * Con molti campionati/stagioni, un solo run NON basta a completare tutto:
 * lo script si ferma da solo quando finisce il budget di chiamate di questo
 * run (MAX_CALLS_PER_RUN) e salva il progresso, così il run successivo
 * riprende esattamente da dove si era fermato, senza sprecare nulla.
 *
 * IMPORTANTE - non testato con una chiave reale (questo ambiente non ha
 * accesso di rete): i nomi dei campi sono presi dalla documentazione e da
 * risposte reali viste nei log di chi lo esegue, ma vanno sempre confrontati
 * con l'output vero prima di fidarsi ciecamente.
 * ----------------------------------------------------------------------------
 */

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const BASE_URL = "https://v3.football.api-sports.io";
const OUTPUT_DIR = "output"; // cartella con i file pronti per l'hosting statico
const RAW_PLAYERS_FILE = "raw-players.json"; // da committare, persiste tra i run
const PROGRESS_FILE = "sync-progress.json"; // da committare, persiste tra i run
const BUILD_VERSION = new Date().toISOString(); // es. "2026-09-19T14:32:07.123Z" - include l'ora apposta: due run nello stesso giorno devono avere versioni diverse, altrimenti la cache del gioco non si accorge che i dati sono cambiati

// Finestra di stagioni da spazzolare. Con 6 campionati, tutta la finestra
// 1995-2025 (31 stagioni) richiede circa 2 ore e mezza per un giro completo -
// comodamente dentro sia il limite di 6 ore di GitHub Actions sia la quota
// giornaliera. Se in futuro riaggiungi altri campionati, valuta se restringerla.
const SEASON_RANGE = { from: 1995, to: 2025 };

// Quante chiamate usare al massimo IN QUESTO run, prima di fermarsi e salvare
// il progresso. Tienilo un po' sotto la quota giornaliera reale del tuo
// piano, per lasciare margine ad altre chiamate (es. test o debug manuale).
// ATTENZIONE: GitHub Actions termina forzatamente ogni job dopo 6 ore, SENZA
// salvare nulla (raw-players.json viene scritto una sola volta a fine run,
// più i checkpoint periodici sotto). Il tasso REALE osservato è di circa
// 1,37s/chiamata (non solo i 1200ms di pausa: ci va sommato anche il tempo
// vero di risposta dell'API) - un tetto calcolato solo sulla pausa teorica
// rischia comunque di sforare le 6 ore. Con 12000 chiamate a questo tasso
// reale, un run dura al massimo ~4h34m: margine sia per le 6 ore di GitHub
// sia per non arrivare a sovrapporsi col prossimo run schedulato 6 ore dopo.
const MAX_CALLS_PER_RUN = Number(process.env.MAX_CALLS_PER_RUN ?? 12000);

// Sotto questa soglia di presenze totali in carriera, un giocatore non vale
// una chiamata dedicata ai trofei (probabilmente non ne ha comunque).
const MIN_APPS_FOR_TROPHIES = 50;

// Sotto questa soglia di presenze totali in carriera, un giocatore non entra
// nel dataset finale del gioco (troppo marginale per essere un indizio utile).
const MIN_APPS_TO_INCLUDE = 20;

// I campionati da spazzolare. apiName + country servono a trovare l'ID
// numerico vero del campionato (lo scopriamo dall'API, non lo indoviniamo -
// serve perché più campionati nel mondo condividono lo stesso nome: la Serie
// A italiana e il Brasileirão si chiamano ENTRAMBI "Serie A" nell'API. Senza
// controllare anche il paese, un giocatore brasiliano finirebbe per errore
// nel campionato italiano).
const LEAGUES_TO_SYNC = [
  { id: "seriea", apiName: "Serie A", country: "Italy" },
  { id: "pl", apiName: "Premier League", country: "England" },
  { id: "laliga", apiName: "La Liga", country: "Spain" },
  { id: "bundesliga", apiName: "Bundesliga", country: "Germany" },
  { id: "ligue1", apiName: "Ligue 1", country: "France" },
  { id: "liga_pt", apiName: "Primeira Liga", country: "Portugal" }
  // Tolti per adesso: MLS, Super Lig (Turchia), Saudi Pro League, Qatar
  // Stars League, Brasileirão, Ekstraklasa (Polonia). Si possono
  // rimettere in futuro semplicemente aggiungendo di nuovo la riga qui.
];

const GK_POSITION = "Goalkeeper";

// Per i lanci di TEST: se imposti la variabile d'ambiente SYNC_LEAGUES (es.
// "seriea" o "seriea,pl"), lo script lavora solo su quei campionati invece
// che su tutto LEAGUES_TO_SYNC - comodo per verificare che tutto funzioni
// spendendo pochissime chiamate, senza modificare il codice. Il workflow
// GitHub passa questo valore dal form di "Run workflow" (vedi sync.yml).
function getActiveLeagues() {
  const filter = (process.env.SYNC_LEAGUES || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (filter.length === 0) return LEAGUES_TO_SYNC;
  return LEAGUES_TO_SYNC.filter((l) => filter.includes(l.id));
}

// Stesso principio per la finestra di stagioni: SYNC_SEASON_FROM / _TO.
function getSeasonRange() {
  const from = process.env.SYNC_SEASON_FROM ? Number(process.env.SYNC_SEASON_FROM) : SEASON_RANGE.from;
  const to = process.env.SYNC_SEASON_TO ? Number(process.env.SYNC_SEASON_TO) : SEASON_RANGE.to;
  return { from, to };
}

// Molti piani (incluso il Free) limitano le stagioni accessibili e lo dicono
// nel messaggio di errore ("... try from 2022 to 2024"). Lo scopriamo alla
// prima richiesta negata e lo riusiamo per tutte le chiamate successive.
let planSeasonRange = null; // { min, max } oppure null se non ancora scoperto
function resetPlanSeasonRangeForTests() { planSeasonRange = null; }

// ---------------------------------------------------------------------------
// Chiamate API di base
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ritorna la risposta COMPLETA (response + paging), non solo i dati, perché
 * lo sweep dei campionati ha bisogno dell'informazione di paginazione.
 */
async function apiGetFull(path, params, budget) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    throw new Error("Variabile d'ambiente API_FOOTBALL_KEY non impostata.");
  }
  const url = new URL(BASE_URL + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { "x-apisports-key": API_KEY } });
  if (!res.ok) {
    throw new Error(`Richiesta fallita (${res.status}) per ${url}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    const message = JSON.stringify(json.errors);
    // La quota giornaliera esaurita è un caso a parte da qualunque altro
    // errore: UNA VOLTA che succede, OGNI chiamata successiva fallirà
    // identica - continuare a riprovare stagione per stagione, giocatore per
    // giocatore, sprecherebbe ore (bug reale: un run è arrivato a 2h15m
    // stampando solo questo errore, migliaia di volte, e nel frattempo
    // segnava giocatori come "completati" senza aver recuperato nulla).
    // Appena la vediamo, azzeriamo il budget condiviso: ogni ciclo del
    // programma controlla già "budget.remaining <= 0" all'inizio di ogni
    // giro, quindi si ferma al prossimo controllo, non dopo ore.
    const isQuotaExceeded = /request limit for the day/i.test(message);
    const err = new Error(`API-Football ha risposto con errori: ${message}`);
    err.isQuotaExceeded = isQuotaExceeded;
    if (isQuotaExceeded && budget) {
      budget.remaining = 0;
      budget.quotaExceeded = true;
    }
    throw err;
  }
  await sleep(Number(process.env.SYNC_RATE_LIMIT_DELAY_MS ?? 1200));
  return json;
}

async function apiGet(path, params, budget) {
  const json = await apiGetFull(path, params, budget);
  return json.response;
}

// ---------------------------------------------------------------------------
// Risoluzione degli ID numerici dei campionati (scoperti, non indovinati)
// ---------------------------------------------------------------------------

async function resolveLeagueApiIds(budget, leagueIds) {
  for (const league of getActiveLeagues()) {
    if (leagueIds && leagueIds[league.id]) { league.numericId = leagueIds[league.id]; continue; } // già risolto in un run precedente, salvato nel progresso
    if (league.numericId) continue;
    if (budget.remaining <= 0) return;
    try {
      const results = await apiGet("/leagues", { name: league.apiName, country: league.country }, budget);
      budget.remaining--;
      if (!results || results.length === 0) {
        console.warn(`  ! Campionato non trovato: "${league.apiName}" (${league.country}) - verrà saltato`);
        continue;
      }
      league.numericId = results[0].league.id;
      if (leagueIds) leagueIds[league.id] = league.numericId;
      console.log(`  -> ${league.apiName} (${league.country}) = id campionato ${league.numericId}`);
    } catch (err) {
      console.warn(`  ! Errore risolvendo "${league.apiName}" (${league.country}): ${err.message}`);
      if (err.isQuotaExceeded) return; // quota esaurita: inutile provare gli altri campionati
    }
  }
}

// ---------------------------------------------------------------------------
// Trova, tra i campionati configurati, quello che corrisponde a una riga di
// statistiche restituita dall'API (per nome E paese: vedi il commento sulla
// collisione Italia/Brasile "Serie A" più sopra).
// ---------------------------------------------------------------------------

// Alcuni campionati vengono riportati con piccole variazioni di spelling a
// seconda della stagione (es. "1. Bundesliga" invece di "Bundesliga" -
// prefisso burocratico usato per distinguerla dalla "2. Bundesliga", non
// sempre presente). Un confronto ESATTO farebbe sfuggire quelle stagioni,
// che finirebbero trattate come campionato "non tracciato" a sé - bug reale
// trovato dall'utente: la carriera al Werder Bremen usciva spezzata in più
// tappe che si sovrapponevano negli anni, invece di una sola tappa continua.
function normalizeLeagueName(name) {
  return (name || "").replace(/^1\.\s*/i, "").trim().toLowerCase();
}
function matchLeague(name, country) {
  const norm = normalizeLeagueName(name);
  return LEAGUES_TO_SYNC.find((l) => normalizeLeagueName(l.apiName) === norm && l.country === country);
}

// ---------------------------------------------------------------------------
// Fonde una riga di risposta di /players (un giocatore, con le sue statistiche
// per quella stagione/campionato) dentro la mappa accumulata di tutti i
// giocatori scoperti finora.
// ---------------------------------------------------------------------------

function mergePlayerEntry(playersMap, entry, season) {
  const p = entry.player;
  if (!p || !p.id) return;

  // Il campo "name" di API-Football è spesso abbreviato (es. "L. Messi"); il
  // nome per esteso, quando disponibile, si ricostruisce da firstname +
  // lastname. Ricalcolato a OGNI passaggio (non solo alla prima creazione)
  // così un giocatore già salvato con il nome abbreviato in una sincronizzazione
  // precedente si autocorregge al prossimo run, senza dover ripartire da zero.
  const fullName = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
  const bestName = fullName || p.name;
  const birthYear = p.birth?.date ? Number(p.birth.date.slice(0, 4)) : null;

  let rec = playersMap.get(p.id);
  if (!rec) {
    rec = {
      id: p.id,
      name: bestName,
      nationality: p.nationality || null,
      birthYear,
      isGK: false,
      // Non aggreghiamo più qui per club+campionato: salviamo ogni stagione
      // come riga a sé. Il raggruppamento in tappe di carriera avviene solo
      // in finalizeCareer(), in ordine cronologico vero - così un prestito
      // (stessa squadra, ma con un'interruzione nel mezzo) risulta in tappe
      // separate invece di un unico blocco che nasconde l'interruzione.
      seasonRecords: [], // { season, club, league, leagueRaw, country, apps, goals }
      trophies: null,
      trophiesFetched: false,
      // true solo dopo il recupero COMPLETO della carriera (tutte le stagioni,
      // non solo i campionati che spazzoliamo) - fatto una volta sola, mai più.
      careerBackfilled: false
    };
    playersMap.set(p.id, rec);
  } else {
    if (fullName) rec.name = fullName; // aggiorna anche un record già esistente, se ora abbiamo il nome per esteso
    if (birthYear && !rec.birthYear) rec.birthYear = birthYear;
  }

  // Un giocatore già arricchito con la carriera COMPLETA (fetchFullCareer)
  // ha già tutte le sue stagioni, in qualunque campionato tracciato - anche
  // quello che stiamo spazzolando ora. Aggiungere di nuovo le righe da qui
  // rischierebbe di contare due volte la stessa stagione (dedupedSeasonRecords
  // somma le righe con la stessa chiave). Il nome/anno di nascita sopra si
  // aggiornano comunque; le statistiche no, sono già complete.
  if (rec.careerBackfilled) return;

  const statsList = entry.statistics || [];
  statsList.forEach((s) => {
    const leagueMeta = matchLeague(s.league?.name, s.league?.country);
    if (!leagueMeta) return; // coppa, amichevole, nazionale, o campionato non tracciato: scartato di proposito

    const apps = s.games?.appearences || 0;
    if (apps === 0) return;

    const isGK = s.games?.position === GK_POSITION;
    if (isGK) rec.isGK = true;

    const goals = s.goals?.total || 0;
    const conceded = s.goals?.conceded || 0;
    const club = s.team?.name || "Squadra sconosciuta";

    rec.seasonRecords.push({ season, club, league: leagueMeta.id, leagueRaw: null, country: null, apps, goals: isGK ? conceded : goals });
  });
}

/**
 * Unisce eventuali righe duplicate (stessa stagione+club+campionato arrivata
 * più di una volta) e ordina per stagione: passo preliminare comune sia a
 * totalApps() sia a finalizeCareer(), così restano sempre coerenti tra loro.
 */
function dedupedSeasonRecords(rec){
  const byKey = new Map();
  (rec.seasonRecords || []).forEach((r) => {
    const compKey = r.league || (r.leagueRaw + "|" + r.country); // id interno se tracciato, altrimenti nome grezzo+paese
    const key = r.season + "|" + r.club + "|" + compKey;
    let existing = byKey.get(key);
    if (!existing) {
      existing = { season: r.season, club: r.club, league: r.league || null, leagueRaw: r.leagueRaw || null, country: r.country || null, apps: 0, goals: 0 };
      byKey.set(key, existing);
    }
    existing.apps += r.apps;
    existing.goals += r.goals;
  });
  return Array.from(byKey.values()).sort((a, b) => a.season - b.season);
}

function totalApps(rec) {
  return dedupedSeasonRecords(rec).reduce((sum, r) => sum + r.apps, 0);
}

function finalizeCareer(rec) {
  const records = dedupedSeasonRecords(rec);
  const stints = [];

  records.forEach((r) => {
    const last = stints[stints.length - 1];
    // Basta che sia lo STESSO CLUB in stagioni consecutive per continuare la
    // stessa tappa, anche se il campionato/competizione tracciata cambia
    // (es. retrocessione e poi promozione: Bologna in Serie A, poi Bologna
    // in Serie B - non tracciata di suo - poi di nuovo Bologna in Serie A:
    // è comunque un'unica permanenza al Bologna, non tre). Un prestito vero
    // resta separato lo stesso, perché il club "di mezzo" è diverso
    // (Atalanta, non Bologna) e quindi rompe comunque la continuità.
    const isContinuation = last && last.club === r.club && r.season === last.maxYear + 1;
    if (isContinuation) {
      last.maxYear = r.season;
      last.apps += r.apps;
      last.goals += r.goals;
      // Per mostrare un solo campionato/livello nella tappa fusa, teniamo
      // quello della stagione con più presenze - il più rappresentativo
      // del tempo passato lì, non necessariamente l'ultimo o il primo.
      if (r.apps > last.repApps) {
        last.repApps = r.apps;
        last.league = r.league;
        last.leagueRaw = r.leagueRaw;
        last.country = r.country;
      }
    } else {
      // Squadra diversa, O la stessa squadra ma con un'interruzione nel
      // mezzo (es. un prestito e poi il ritorno, con un ALTRO club in
      // mezzo): in ogni caso si apre una NUOVA tappa, non si allunga
      // quella precedente.
      stints.push({ club: r.club, league: r.league, leagueRaw: r.leagueRaw, country: r.country, minYear: r.season, maxYear: r.season, apps: r.apps, goals: r.goals, repApps: r.apps });
    }
  });

  return stints.map((s) => ({
    years: s.minYear === s.maxYear ? String(s.minYear) : `${s.minYear}–${s.maxYear + 1}`,
    club: s.club,
    league: s.league,
    leagueRaw: s.leagueRaw,
    country: s.country,
    apps: s.apps,
    goals: s.goals
  }));
}

// ---------------------------------------------------------------------------
// Spazzola un campionato/stagione, pagina per pagina, fondendo ogni giocatore
// trovato nella mappa accumulata. Si ferma (senza completare) se il budget
// di chiamate del run finisce a metà: la coppia campionato/stagione NON
// viene segnata come completata, quindi il run successivo la rifà da capo
// (semplificazione voluta: niente ripresa a metà pagina, solo a metà stagione).
// ---------------------------------------------------------------------------

async function sweepLeagueSeason(league, season, playersMap, budget) {
  let page = 1;
  let totalPages = 1;

  do {
    if (budget.remaining <= 0) return { completed: false, reason: "budget" };

    let json;
    try {
      json = await apiGetFull("/players", { league: league.numericId, season, page }, budget);
    } catch (err) {
      const rangeMatch = err.message.match(/try from (\d+) to (\d+)/);
      if (rangeMatch) {
        planSeasonRange = { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
        console.warn(`  Il piano limita le stagioni a ${planSeasonRange.min}-${planSeasonRange.max}: salto questa stagione.`);
        return { completed: true, reason: "planRange" };
      }
      console.warn(`  Errore su ${league.id} ${season} pagina ${page}: ${err.message}`);
      if (err.isQuotaExceeded) return { completed: false, reason: "budget" }; // quota esaurita: come budget a zero, ferma tutto
      // Un errore isolato (rete, risposta imprevista...) NON deve fermare il
      // resto del run: si salta questa combinazione (riproverà un run futuro,
      // dato che non viene segnata come completata) e si continua con le altre.
      return { completed: false, reason: "error" };
    }
    budget.remaining--;

    (json.response || []).forEach((entry) => mergePlayerEntry(playersMap, entry, season));
    totalPages = json.paging?.total || 1;
    page++;
  } while (page <= totalPages);

  return { completed: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Palmares: solo per chi supera la soglia minima di presenze totali, e solo
// se non già scaricato in un run precedente.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Carriera COMPLETA (fuori dai campionati che spazzoliamo): solo per chi ha
// già superato la soglia minima di presenze nella spazzolata normale, e solo
// una volta per sempre (vedi careerBackfilled). Interroga l'API per ID del
// giocatore, stagione per stagione - non più per campionato - quindi vede
// TUTTO quello che ha giocato, non solo i 6 campionati tracciati.
//
// Non abbiamo un catalogo di tutti i campionati del mondo per distinguere un
// vero campionato domestico da una coppa o dalla nazionale: usiamo un elenco
// di parole chiave da ESCLUDERE invece che un elenco da includere. È una
// euristica, non perfetta (un ipotetico campionato chiamato per davvero
// "... Cup" verrebbe scartato per errore), ma ragionevole nella pratica.
// ---------------------------------------------------------------------------

const NON_LEAGUE_KEYWORDS = [
  "cup", "copa", "coppa", "coupe", "pokal", "beker", "taça", "taca", "champions league", "europa league", "conference league",
  "friendl", "world cup", "euro championship", "european championship", "euro -", "qualif", "super cup",
  "shield", "trophy", "community", "confederations", "nations league",
  "intercontinental", "club world cup", "youth league", "playoff", "play-off", "play off",
  "africa cup", "copa américa", "copa america", "asian cup", "gold cup", "olympic",
  // Trovate scandagliando i dati reali con audit-raw-data.mjs, non solo ipotizzate:
  "primavera", "reserve", // squadre giovanili/riserve di club (l'utente ha chiesto di escluderle: solo prima squadra)
  "academy", "all-star", "all star",
  "canadian championship", "eaff e-1", "waff championship",
  "afc championship", "south american championship", "asean club championship"
];
// Le nazionali (comprese quelle giovanili: U17, U19, U21...) hanno come
// "squadra" il nome del paese seguito dalla categoria d'età - non un vero
// club - quindi non sono riconoscibili dal solo nome del campionato (es.
// "UEFA U17 Championship" non somiglia a nessuna delle parole scartate sopra).
// Bug reale: senza questo controllo, le presenze in under-17/19/21 finivano
// mescolate nella carriera come se fossero un club vero.
const YOUTH_OR_NATIONAL_TEAM_PATTERN = /\bu-?(1[5-9]|2[0-3])\b/i;

// Le nazionali MAGGIORI (non giovanili) non hanno un suffisso d'età nel nome
// della squadra - si chiamano semplicemente come il paese ("Italy", "Brazil"...).
// Nessun club vero al mondo si chiama così: se il nome squadra coincide con
// un paese, è quasi certamente una convocazione in nazionale, qualunque sia
// il nome del torneo (comprese amichevoli o tornei invitational mai visti
// prima, che nessun elenco di parole chiave potrebbe coprire in anticipo).
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

function isLikelyDomesticLeague(name, teamName){
  if (!name) return false;
  if (teamName) {
    if (YOUTH_OR_NATIONAL_TEAM_PATTERN.test(teamName)) return false;
    if (NATION_NAMES.has(teamName.trim().toLowerCase())) return false;
  }
  const lower = name.toLowerCase();
  return !NON_LEAGUE_KEYWORDS.some((kw) => lower.includes(kw));
}

// Se non conosciamo l'anno di nascita del giocatore, da che anno iniziamo a
// cercare: un limite ragionevole per non sprecare chiamate su decenni in cui
// quasi certamente non giocava ancora.
// 2001: confermato sui dati reali che prima di questo anno il piano API non
// restituisce quasi mai nulla di utile (20 righe su oltre 61.000 in tutto
// l'archivio, in 3 stagioni). Risparmia chiamate quasi sempre a vuoto sui
// giocatori più anziani, senza perdere dati che comunque non arriverebbero.
const BACKFILL_FALLBACK_FROM_YEAR = 2001;

// Nel recupero della carriera completa: dopo aver trovato dati reali, quante
// stagioni consecutive vuote bastano per concludere che il giocatore si è
// ritirato e fermarsi, invece di controllare comunque fino all'ultima
// stagione configurata.
const EARLY_STOP_AFTER_EMPTY_SEASONS = 3;

async function fetchFullCareer(playerId, birthYear, budget) {
  const fromYear = birthYear ? Math.max(BACKFILL_FALLBACK_FROM_YEAR, birthYear + 15) : BACKFILL_FALLBACK_FROM_YEAR;
  const toYear = SEASON_RANGE.to;
  const records = [];

  // Dopo aver TROVATO dati reali, se per alcune stagioni consecutive non ne
  // troviamo più (andando avanti verso il presente), il giocatore si è
  // quasi certamente ritirato: ci fermiamo, non serve controllare fino al
  // 2025 per forza. ATTENZIONE: questo conteggio parte solo DOPO aver già
  // trovato la prima stagione vera - mai prima, altrimenti si ripete lo
  // stesso errore già preso con la vecchia euristica (fermarsi troppo presto
  // per chi ha debuttato tardi, prima ancora di trovare i suoi anni veri).
  let foundAnyData = false;
  let consecutiveEmpty = 0;

  for (let season = fromYear; season <= toYear; season++) {
    if (budget.remaining <= 0) return { completed: false, records };

    let json;
    try {
      json = await apiGetFull("/players", { id: playerId, season }, budget);
    } catch (err) {
      const rangeMatch = err.message.match(/try from (\d+) to (\d+)/);
      if (rangeMatch) continue; // stagione fuori dal range permesso dal piano: salta, non è un errore vero
      console.warn(`    carriera completa id ${playerId} stagione ${season}: errore (${err.message})`);
      if (err.isQuotaExceeded) return { completed: false, records }; // quota esaurita: fermarsi QUI, non su tutte le stagioni rimaste
      continue;
    }
    budget.remaining--;

    const statsList = (json.response && json.response[0] && json.response[0].statistics) || [];
    let seasonHadApps = false;
    statsList.forEach((s) => {
      const apps = s.games?.appearences || 0;
      if (apps === 0) return;
      if (!isLikelyDomesticLeague(s.league?.name, s.team?.name)) return; // coppe, nazionale (anche giovanile), amichevoli: fuori anche qui
      seasonHadApps = true;

      const isGK = s.games?.position === GK_POSITION;
      const goals = s.goals?.total || 0;
      const conceded = s.goals?.conceded || 0;
      const club = s.team?.name || "Squadra sconosciuta";
      const matchedLeague = matchLeague(s.league?.name, s.league?.country);

      records.push({
        season,
        club,
        league: matchedLeague ? matchedLeague.id : null,
        leagueRaw: matchedLeague ? null : (s.league?.name || null),
        country: matchedLeague ? null : (s.league?.country || null),
        apps,
        goals: isGK ? conceded : goals
      });
    });

    if (seasonHadApps) {
      foundAnyData = true;
      consecutiveEmpty = 0;
    } else if (foundAnyData) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= EARLY_STOP_AFTER_EMPTY_SEASONS) break; // probabile ritiro: non serve controllare fino in fondo
    }
  }

  return { completed: true, records };
}

async function fetchTrophies(playerId, budget) {
  let raw;
  try {
    raw = await apiGet("/trophies", { player: playerId }, budget);
    if (budget) budget.remaining--; // mancava: il conteggio "chiamate usate" era sottostimato
  } catch (err) {
    console.warn(`    trofei per id ${playerId}: errore (${err.message})`);
    return [];
  }
  if (!raw) return [];

  // Raggruppiamo per nome DELLA COMPETIZIONE + PAESE insieme, non solo per
  // nome: una "Super Cup" può esistere identica di nome in più paesi (Italia,
  // Spagna, Turchia...) - raggruppare solo per nome le confonderebbe tra loro.
  // Scartiamo le righe senza una stagione: nei dati reali si sono viste
  // righe duplicate della STESSA vittoria, una con la stagione e una senza -
  // contarle entrambe gonfia il conteggio (es. "2 volte" quando è successo
  // una volta sola). Una riga senza stagione non è comunque mostrabile bene
  // nel gioco, quindi scartarla non perde informazione utile.
  const wins = raw.filter((t) => /winner/i.test(t.place || "") && t.season);
  const grouped = {};
  wins.forEach((t) => {
    const key = t.league + "|" + (t.country || "");
    if (!grouped[key]) grouped[key] = { leagueName: t.league, country: t.country || null, count: 0, seasons: [] };
    grouped[key].count += 1;
    grouped[key].seasons.push(t.season);
  });

  return Object.values(grouped).map((g) => {
    // Stessa disambiguazione nome+paese già usata per la carriera (matchLeague):
    // se è uno dei nostri campionati domestici tracciati, "comp" diventa il
    // nostro id interno (es. "seriea"). Altrimenti (coppe, competizioni
    // internazionali) "comp" resta il nome grezzo dell'API, ma il paese
    // viene comunque salvato a parte: il gioco lo usa per non mostrare, per
    // esempio, "Super Cup" senza sapere di quale paese si tratta.
    //
    // NOTA: qui NON costruiamo più una frase già scritta in italiano - solo
    // i FATTI (competizione, paese, quante volte, quali stagioni). La frase
    // nella lingua giusta la costruisce il gioco al momento di mostrarla.
    const matchedLeague = matchLeague(g.leagueName, g.country);
    const comp = matchedLeague ? matchedLeague.id : g.leagueName;
    return { comp, country: matchedLeague ? null : g.country, count: g.count, seasons: g.seasons };
  });
}

// ---------------------------------------------------------------------------
// Persistenza tra un run e l'altro
// ---------------------------------------------------------------------------

async function loadJsonIfExists(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return fallback;
  }
}

async function loadRawPlayers() {
  const raw = await loadJsonIfExists(RAW_PLAYERS_FILE, { players: [] });
  const map = new Map();
  raw.players.forEach((p) => {
    map.set(p.id, { ...p, seasonRecords: p.seasonRecords || [] });
  });
  return map;
}

async function saveRawPlayers(playersMap) {
  const players = Array.from(playersMap.values()).map((rec) => ({
    id: rec.id,
    name: rec.name,
    nationality: rec.nationality,
    birthYear: rec.birthYear || null,
    isGK: rec.isGK,
    trophies: rec.trophies,
    trophiesFetched: rec.trophiesFetched,
    careerBackfilled: !!rec.careerBackfilled,
    seasonRecords: rec.seasonRecords
  }));
  await fs.writeFile(RAW_PLAYERS_FILE, JSON.stringify({ version: BUILD_VERSION, players }, null, 2), "utf-8");
}

async function loadProgress() {
  const raw = await loadJsonIfExists(PROGRESS_FILE, { completed: [], leagueIds: {} });
  return { completed: new Set(raw.completed), leagueIds: raw.leagueIds || {} };
}

async function saveProgress(progress) {
  await fs.writeFile(
    PROGRESS_FILE,
    JSON.stringify({ completed: Array.from(progress.completed), leagueIds: progress.leagueIds || {} }, null, 2),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// Dataset finale per il gioco (filtrato, nella forma che il prototipo usa già)
// ---------------------------------------------------------------------------

function buildFinalDataset(playersMap) {
  const result = [];
  playersMap.forEach((rec) => {
    if (totalApps(rec) < MIN_APPS_TO_INCLUDE) return;
    result.push({
      id: slugify(rec.name) + "-" + rec.id, // l'id numerico evita collisioni tra omonimi veri
      name: rec.name,
      nationality: rec.nationality,
      isGK: rec.isGK,
      career: finalizeCareer(rec),
      careerComplete: !!rec.careerBackfilled, // false = carriera solo dai campionati tracciati, non ancora arricchita per intero
      trophies: rec.trophies || []
    });
  });
  return result;
}

function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Output per l'hosting statico (shard per campionato + manifest)
// ---------------------------------------------------------------------------

async function writeOutputFiles(players) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  await fs.writeFile(
    `${OUTPUT_DIR}/players-data.json`,
    JSON.stringify({ version: BUILD_VERSION, players }, null, 2),
    "utf-8"
  );

  const shards = {};
  players.forEach((p) => {
    // Solo le tappe nei campionati che tracciamo davvero determinano lo shard:
    // una tappa "fuori catalogo" (league null, solo leagueRaw+country) non
    // deve creare uno shard "null.json".
    const leaguesForPlayer = new Set(p.career.filter((c) => c.league).map((c) => c.league));
    leaguesForPlayer.forEach((leagueId) => {
      if (!shards[leagueId]) shards[leagueId] = [];
      shards[leagueId].push(p);
    });
  });

  const manifest = { version: BUILD_VERSION, leagues: {} };
  for (const [leagueId, leaguePlayers] of Object.entries(shards)) {
    const fileName = `${leagueId}.json`;
    await fs.writeFile(
      `${OUTPUT_DIR}/${fileName}`,
      JSON.stringify({ version: BUILD_VERSION, players: leaguePlayers }, null, 2),
      "utf-8"
    );
    manifest.leagues[leagueId] = { file: fileName, version: BUILD_VERSION, count: leaguePlayers.length };
  }

  await fs.writeFile(`${OUTPUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2), "utf-8");

  console.log(`\nScritti in ./${OUTPUT_DIR}/: players-data.json (${players.length} giocatori) + ${Object.keys(shards).length} shard + manifest.json`);
}

// ---------------------------------------------------------------------------
// Checkpoint periodico: GitHub Actions termina forzatamente ogni job dopo 6
// ore, SENZA salvare nulla di quello che stava facendo. Salvare solo alla
// fine del run (come si faceva prima) significa rischiare di perdere ORE di
// lavoro vero se il run dura più del previsto. Qui invece salviamo su disco
// E pubblichiamo su Git ogni tot chiamate, non solo all'ultimo momento: se
// il job viene ucciso, si perde solo il lavoro dall'ultimo checkpoint in
// poi, non l'intero run.
// ---------------------------------------------------------------------------
const CHECKPOINT_INTERVAL_CALLS = 2000; // ogni ~40 minuti circa, con la pausa di sicurezza attuale

function runGit(cmd) {
  execSync(cmd, { stdio: "pipe" });
}

async function checkpointSave(playersMap, progress, label) {
  await saveRawPlayers(playersMap);
  await saveProgress(progress);
  try {
    runGit(`git config user.name "sync-bot"`);
    runGit(`git config user.email "sync-bot@users.noreply.github.com"`);
    runGit(`git add raw-players.json sync-progress.json`);

    let hasChanges = true;
    try {
      runGit(`git diff --staged --quiet`); // esce con codice 0 se NON ci sono differenze
      hasChanges = false;
    } catch {
      hasChanges = true; // esce con codice diverso da 0 se CI SONO differenze: caso normale
    }
    if (!hasChanges) return;

    runGit(`git commit -m "chore: salvataggio intermedio (${label}) [skip ci]"`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        runGit(`git fetch origin main`);
        runGit(`git rebase origin/main`);
        runGit(`git push`);
        console.log(`  [checkpoint] progresso salvato e pubblicato (${label}).`);
        return;
      } catch (err) {
        try { runGit(`git rebase --abort`); } catch {}
        if (attempt === 3) throw err;
        await sleep(5000);
      }
    }
  } catch (err) {
    // Un checkpoint fallito non deve far cadere tutto il run: si continua
    // a lavorare, si riprova al prossimo checkpoint. Nel peggiore dei casi
    // si torna al comportamento di prima (salvataggio solo a fine run).
    console.log(`  [checkpoint] salvataggio intermedio non riuscito, proseguo comunque: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const budget = { remaining: MAX_CALLS_PER_RUN };
  let callsAtLastCheckpoint = MAX_CALLS_PER_RUN;
  async function maybeCheckpoint(playersMap, progress, label) {
    const usedSinceLast = callsAtLastCheckpoint - budget.remaining;
    if (usedSinceLast >= CHECKPOINT_INTERVAL_CALLS) {
      await checkpointSave(playersMap, progress, label);
      callsAtLastCheckpoint = budget.remaining;
    }
  }

  console.log("Carico progresso e dati grezzi salvati dai run precedenti...");
  const playersMap = await loadRawPlayers();
  const progress = await loadProgress();
  console.log(`  giocatori già in archivio: ${playersMap.size}`);
  console.log(`  combinazioni campionato/stagione già completate: ${progress.completed.size}`);

  console.log("\nRisolvo gli ID numerici dei campionati...");
  await resolveLeagueApiIds(budget, progress.leagueIds);

  console.log("\nSpazzolo campionati e stagioni ancora da fare...");
  var activeLeagues = getActiveLeagues();
  var activeSeasons = getSeasonRange();
  if (activeLeagues.length < LEAGUES_TO_SYNC.length || activeSeasons.from !== SEASON_RANGE.from || activeSeasons.to !== SEASON_RANGE.to) {
    console.log(`  (run con scope ridotto per test: campionati [${activeLeagues.map((l) => l.id).join(", ")}], stagioni ${activeSeasons.from}-${activeSeasons.to})`);
  }
  let stoppedForBudget = false;
  outer:
  for (const league of activeLeagues) {
    if (!league.numericId) continue; // non risolto (campionato non trovato o budget finito prima)
    for (let season = activeSeasons.from; season <= activeSeasons.to; season++) {
      const key = `${league.id}:${season}`;
      if (progress.completed.has(key)) continue;
      if (budget.remaining <= 0) { stoppedForBudget = true; break outer; }

      console.log(`  ${league.apiName} (${league.country}) ${season}...`);
      const result = await sweepLeagueSeason(league, season, playersMap, budget);
      if (result.completed) {
        progress.completed.add(key);
        await maybeCheckpoint(playersMap, progress, "spazzolata");
      } else if (result.reason === "budget") {
        // Budget davvero esaurito: qui ha senso fermare tutto il run, il
        // prossimo riprenderà esattamente da questa combinazione.
        stoppedForBudget = true;
        break outer;
      }
      // reason === "error": combinazione saltata (non segnata completata,
      // quindi un run futuro la riprova), ma si continua con le altre - un
      // singolo errore isolato non deve far perdere il resto del lavoro.
    }
  }

  console.log("\nRecupero la carriera COMPLETA (anche fuori dai nostri campionati) per chi supera la soglia...");
  for (const rec of playersMap.values()) {
    if (budget.remaining <= 0) { stoppedForBudget = true; break; }
    if (rec.careerBackfilled) continue;
    if (totalApps(rec) < MIN_APPS_TO_INCLUDE) continue;
    const result = await fetchFullCareer(rec.id, rec.birthYear, budget);
    if (result.completed) {
      rec.seasonRecords = result.records; // sostituisce del tutto: il recupero completo include già i campionati tracciati
      rec.careerBackfilled = true;
      await maybeCheckpoint(playersMap, progress, "recupero carriera");
    }
    // se non completato (budget finito a metà), NON segniamo backfilled: il
    // prossimo run riprova da capo per questo giocatore (nessun dato perso,
    // restano i seasonRecords della spazzolata normale nel frattempo).
  }

  console.log("\nScarico il palmares per chi ha presenze sufficienti...");
  for (const rec of playersMap.values()) {
    if (budget.remaining <= 0) { stoppedForBudget = true; break; }
    if (rec.trophiesFetched) continue;
    if (totalApps(rec) < MIN_APPS_FOR_TROPHIES) continue;
    rec.trophies = await fetchTrophies(rec.id, budget);
    rec.trophiesFetched = true;
    await maybeCheckpoint(playersMap, progress, "trofei");
  }

  await saveRawPlayers(playersMap);
  await saveProgress(progress);

  const finalPlayers = buildFinalDataset(playersMap);
  await writeOutputFiles(finalPlayers);

  const doneTotal = activeLeagues.length * (activeSeasons.to - activeSeasons.from + 1);
  console.log(`\nChiamate usate in questo run: ${MAX_CALLS_PER_RUN - budget.remaining} di ${MAX_CALLS_PER_RUN}`);
  console.log(`Combinazioni campionato-stagione completate: ${progress.completed.size} di ${doneTotal}`);
  if (progress.completed.size >= doneTotal) {
    console.log("Sincronizzazione completa per la finestra di stagioni configurata.");
  } else if (stoppedForBudget) {
    console.log("Budget di questo run esaurito prima di finire tutto: il prossimo lancio riprende da dove si è fermato.");
  } else {
    console.log("Il run è terminato senza completare tutto (controlla gli avvisi sopra: quota API, campionati non risolti, o errori isolati). Il prossimo lancio riproverà le combinazioni non ancora segnate come completate.");
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("Errore fatale:", err);
    process.exit(1);
  });
}

export {
  slugify,
  matchLeague,
  isLikelyDomesticLeague,
  mergePlayerEntry,
  finalizeCareer,
  totalApps,
  sweepLeagueSeason,
  fetchFullCareer,
  fetchTrophies,
  buildFinalDataset,
  writeOutputFiles,
  resolveLeagueApiIds,
  getActiveLeagues,
  getSeasonRange,
  loadRawPlayers,
  saveRawPlayers,
  loadProgress,
  saveProgress,
  LEAGUES_TO_SYNC,
  resetPlanSeasonRangeForTests
};
