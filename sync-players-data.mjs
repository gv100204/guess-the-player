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
const MAX_CALLS_PER_RUN = Number(process.env.MAX_CALLS_PER_RUN ?? 7000);

// Sotto questa soglia di presenze totali in carriera, un giocatore non vale
// una chiamata dedicata ai trofei (probabilmente non ne ha comunque).
const MIN_APPS_FOR_TROPHIES = 50;

// Sotto questa soglia di presenze totali in carriera, un giocatore non entra
// nel dataset finale del gioco (troppo marginale per essere un indizio utile).
const MIN_APPS_TO_INCLUDE = 10;

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
async function apiGetFull(path, params) {
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
    throw new Error(`API-Football ha risposto con errori: ${JSON.stringify(json.errors)}`);
  }
  await sleep(Number(process.env.SYNC_RATE_LIMIT_DELAY_MS ?? 1200));
  return json;
}

async function apiGet(path, params) {
  const json = await apiGetFull(path, params);
  return json.response;
}

// ---------------------------------------------------------------------------
// Risoluzione degli ID numerici dei campionati (scoperti, non indovinati)
// ---------------------------------------------------------------------------

async function resolveLeagueApiIds(budget) {
  for (const league of getActiveLeagues()) {
    if (league.numericId) continue; // già risolto in un run precedente (persistito nel progress)
    if (budget.remaining <= 0) return;
    try {
      const results = await apiGet("/leagues", { name: league.apiName, country: league.country });
      budget.remaining--;
      if (!results || results.length === 0) {
        console.warn(`  ! Campionato non trovato: "${league.apiName}" (${league.country}) - verrà saltato`);
        continue;
      }
      league.numericId = results[0].league.id;
      console.log(`  -> ${league.apiName} (${league.country}) = id campionato ${league.numericId}`);
    } catch (err) {
      console.warn(`  ! Errore risolvendo "${league.apiName}" (${league.country}): ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Trova, tra i campionati configurati, quello che corrisponde a una riga di
// statistiche restituita dall'API (per nome E paese: vedi il commento sulla
// collisione Italia/Brasile "Serie A" più sopra).
// ---------------------------------------------------------------------------

function matchLeague(name, country) {
  return LEAGUES_TO_SYNC.find((l) => l.apiName === name && l.country === country);
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

  let rec = playersMap.get(p.id);
  if (!rec) {
    rec = {
      id: p.id,
      name: bestName,
      nationality: p.nationality || null,
      isGK: false,
      // Non aggreghiamo più qui per club+campionato: salviamo ogni stagione
      // come riga a sé. Il raggruppamento in tappe di carriera avviene solo
      // in finalizeCareer(), in ordine cronologico vero - così un prestito
      // (stessa squadra, ma con un'interruzione nel mezzo) risulta in tappe
      // separate invece di un unico blocco che nasconde l'interruzione.
      seasonRecords: [], // { season, club, league, apps, goals }
      trophies: null,
      trophiesFetched: false
    };
    playersMap.set(p.id, rec);
  } else if (fullName) {
    rec.name = fullName; // aggiorna anche un record già esistente, se ora abbiamo il nome per esteso
  }

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

    rec.seasonRecords.push({ season, club, league: leagueMeta.id, apps, goals: isGK ? conceded : goals });
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
    const key = r.season + "|" + r.club + "|" + r.league;
    let existing = byKey.get(key);
    if (!existing) {
      existing = { season: r.season, club: r.club, league: r.league, apps: 0, goals: 0 };
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
    const isContinuation = last && last.club === r.club && last.league === r.league && r.season === last.maxYear + 1;
    if (isContinuation) {
      last.maxYear = r.season;
      last.apps += r.apps;
      last.goals += r.goals;
    } else {
      // Squadra diversa, campionato diverso, O la stessa squadra ma con
      // un'interruzione nel mezzo (es. un prestito e poi il ritorno): in
      // ogni caso si apre una NUOVA tappa, non si allunga quella precedente.
      stints.push({ club: r.club, league: r.league, minYear: r.season, maxYear: r.season, apps: r.apps, goals: r.goals });
    }
  });

  return stints.map((s) => ({
    years: s.minYear === s.maxYear ? String(s.minYear) : `${s.minYear}–${s.maxYear + 1}`,
    club: s.club,
    league: s.league,
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
      json = await apiGetFull("/players", { league: league.numericId, season, page });
    } catch (err) {
      const rangeMatch = err.message.match(/try from (\d+) to (\d+)/);
      if (rangeMatch) {
        planSeasonRange = { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
        console.warn(`  Il piano limita le stagioni a ${planSeasonRange.min}-${planSeasonRange.max}: salto questa stagione.`);
        return { completed: true, reason: "planRange" };
      }
      console.warn(`  Errore su ${league.id} ${season} pagina ${page}: ${err.message}`);
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

async function fetchTrophies(playerId) {
  let raw;
  try {
    raw = await apiGet("/trophies", { player: playerId });
  } catch (err) {
    console.warn(`    trofei per id ${playerId}: errore (${err.message})`);
    return [];
  }
  if (!raw) return [];

  // Raggruppiamo per nome DELLA COMPETIZIONE + PAESE insieme, non solo per
  // nome: una "Super Cup" può esistere identica di nome in più paesi (Italia,
  // Spagna, Turchia...) - raggruppare solo per nome le confonderebbe tra loro.
  const wins = raw.filter((t) => /winner/i.test(t.place || ""));
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
    isGK: rec.isGK,
    trophies: rec.trophies,
    trophiesFetched: rec.trophiesFetched,
    seasonRecords: rec.seasonRecords
  }));
  await fs.writeFile(RAW_PLAYERS_FILE, JSON.stringify({ version: BUILD_VERSION, players }, null, 2), "utf-8");
}

async function loadProgress() {
  const raw = await loadJsonIfExists(PROGRESS_FILE, { completed: [] });
  return { completed: new Set(raw.completed) };
}

async function saveProgress(progress) {
  await fs.writeFile(PROGRESS_FILE, JSON.stringify({ completed: Array.from(progress.completed) }, null, 2), "utf-8");
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
    const leaguesForPlayer = new Set(p.career.map((c) => c.league));
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const budget = { remaining: MAX_CALLS_PER_RUN };

  console.log("Carico progresso e dati grezzi salvati dai run precedenti...");
  const playersMap = await loadRawPlayers();
  const progress = await loadProgress();
  console.log(`  giocatori già in archivio: ${playersMap.size}`);
  console.log(`  combinazioni campionato/stagione già completate: ${progress.completed.size}`);

  console.log("\nRisolvo gli ID numerici dei campionati...");
  await resolveLeagueApiIds(budget);

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

  console.log("\nScarico il palmares per chi ha presenze sufficienti...");
  for (const rec of playersMap.values()) {
    if (budget.remaining <= 0) { stoppedForBudget = true; break; }
    if (rec.trophiesFetched) continue;
    if (totalApps(rec) < MIN_APPS_FOR_TROPHIES) continue;
    rec.trophies = await fetchTrophies(rec.id);
    rec.trophiesFetched = true;
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
  mergePlayerEntry,
  finalizeCareer,
  totalApps,
  sweepLeagueSeason,
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
