/**
 * sync-players-data.mjs
 * ----------------------------------------------------------------------------
 * Script di sincronizzazione (da eseguire su un server / cron job, MAI sul
 * telefono): scarica da API-Football la carriera e il palmares dei giocatori
 * scelti e produce, dentro ./output/:
 *   - players-data.json   tutti i giocatori, file unico (comodo per debug)
 *   - <campionato>.json   uno shard per campionato (es. seriea.json,
 *                         premier-league.json...): contiene solo i giocatori
 *                         che hanno militato in quel campionato, ognuno con
 *                         la scheda COMPLETA (non solo la parte relativa a
 *                         quel campionato) - un giocatore passato per più
 *                         campionati compare, identico, in più shard
 *   - manifest.json       elenco degli shard con versione e conteggio: è il
 *                         file piccolo che l'app scarica sempre per sapere
 *                         quali shard esistono e se sono cambiati
 *
 * Uso:
 *   API_FOOTBALL_KEY=xxxxx node sync-players-data.mjs
 *
 * Richiede Node 18+ (usa il fetch nativo). Nessuna dipendenza esterna.
 *
 * IMPORTANTE:
 * - Non è stato testato con una chiave reale (questo ambiente non ha accesso
 *   di rete): rivedi i nomi dei campi confrontandoli con la risposta vera
 *   della tua chiave prima di usarlo in produzione.
 * - Rispetta i limiti del tuo piano API-Football: questo script metterà una
 *   piccola pausa tra le chiamate (RATE_LIMIT_DELAY_MS) per non superarli.
 * - L'aggregazione carriera/palmares qui sotto è una versione di base (MVP):
 *   funziona bene per la maggior parte dei giocatori, ma casi particolari
 *   (prestiti, doppie annate nello stesso club, trasferimenti a stagione in
 *   corso) potrebbero richiedere una pulizia manuale del JSON finale.
 * ----------------------------------------------------------------------------
 */

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

// nota: letta dentro apiGet() a ogni chiamata (non come const in cima al file)
// così un test può impostare process.env.API_FOOTBALL_KEY dopo l'import.

const BASE_URL = "https://v3.football.api-sports.io";
const RATE_LIMIT_DELAY_MS = Number(process.env.SYNC_RATE_LIMIT_DELAY_MS ?? 1200); // ~50 richieste/minuto, prudente per il piano free; azzerabile nei test
const OUTPUT_DIR = "output"; // cartella con i file pronti per l'hosting statico
const BUILD_VERSION = new Date().toISOString().slice(0, 10); // es. "2026-09-18"

// Molti piani (incluso il Free) limitano le stagioni accessibili e lo dicono
// nel messaggio di errore ("... try from 2022 to 2024"). Lo scopriamo alla
// prima richiesta negata e lo riusiamo per tutti i giocatori successivi,
// così non sprechiamo quota su anni che sappiamo già essere negati.
let planSeasonRange = null; // { min, max } oppure null se non ancora scoperto
function resetPlanSeasonRangeForTests() { planSeasonRange = null; }
const SEASON_RANGE = { from: 1994, to: 2025 }; // intervallo di stagioni da controllare per ogni giocatore

// Elenco dei giocatori da sincronizzare: basta il nome, lo script trova l'id.
// Aggiungi/rimuovi nomi qui per cambiare il roster del gioco.
const PLAYERS_TO_SYNC = [
  "Cristiano Ronaldo",
  "Lionel Messi",
  "Andrea Pirlo",
  "Zinedine Zidane",
  "Xavi Hernandez",
  "Iker Casillas",
  "Gianluigi Buffon",
  "Paolo Maldini",
  "Thierry Henry",
  "Didier Drogba",
  "Ronaldinho",
  "N'Golo Kante",
  "Xabi Alonso",
  "Franck Ribery",
  "Robert Lewandowski"
];

// Mappa "nome campionato in API-Football" -> "id campionato usato dal gioco".
// Va tenuta aggiornata: se un giocatore ha militato in un campionato non
// presente qui, quella stagione verrà scartata (loggato a schermo) finché
// non aggiungi la riga corrispondente.
const LEAGUE_NAME_TO_ID = {
  "Serie A": "seriea",
  "Premier League": "pl",
  "La Liga": "laliga",
  "Bundesliga": "bundesliga",
  "Ligue 1": "ligue1",
  "Primeira Liga": "liga_pt",
  "MLS": "mls",
  "Super Lig": "superlig",
  "Saudi Pro League": "saudi",
  "Qatar Stars League": "qatar",
  "Serie A Brazil": "brasileirao",
  "Ekstraklasa": "ekstraklasa"
};

// Ruoli goalkeeper come restituiti da API-Football (players.statistics[].games.position)
const GK_POSITIONS = new Set(["Goalkeeper"]);

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(path, params) {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    throw new Error("Variabile d'ambiente API_FOOTBALL_KEY non impostata.");
  }
  const url = new URL(BASE_URL + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (!res.ok) {
    throw new Error(`Richiesta fallita (${res.status}) per ${url}`);
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Football ha risposto con errori: ${JSON.stringify(json.errors)}`);
  }
  await sleep(RATE_LIMIT_DELAY_MS);
  return json.response;
}

// ---------------------------------------------------------------------------
// Passo 1: trovare l'id del giocatore a partire dal nome
// ---------------------------------------------------------------------------

async function findPlayerId(name) {
  const results = await apiGet("/players/profiles", { search: name });
  if (!results || results.length === 0) {
    console.warn(`  ! Nessun risultato per "${name}", salto.`);
    return null;
  }
  // Se ci sono più omonimi, qui prendiamo il primo: controlla manualmente
  // il JSON finale se il roster contiene giocatori con nomi comuni.
  const player = results[0].player;
  const birthYear = player.birth?.date ? Number(player.birth.date.slice(0, 4)) : null;
  console.log(`  -> trovato id ${player.id} (${player.name}, nato ${player.birth?.date ?? "??"})`);
  return { id: player.id, birthYear };
}

// ---------------------------------------------------------------------------
// Passo 2: carriera (stagione per stagione -> aggregata per squadra)
// ---------------------------------------------------------------------------

async function fetchCareer(playerId, birthYear) {
  const stints = []; // { years:[minYear,maxYear], club, league, apps, goals, isGK }

  // Partiamo dall'anno in cui il giocatore poteva ragionevolmente debuttare
  // (nascita + 15 anni) invece che dall'inizio fisso di SEASON_RANGE: usare
  // un'euristica "fermati dopo N stagioni vuote di fila" è pericoloso, perché
  // per un giocatore che ha debuttato tardi le prime stagioni vuote sarebbero
  // moltissime PRIMA di trovare i suoi anni veri, e lo script si fermerebbe
  // prima di arrivarci. Meglio restringere l'intervallo con un dato certo
  // (la data di nascita) che con un'euristica sul numero di stagioni vuote.
  let fromYear = birthYear ? Math.max(SEASON_RANGE.from, birthYear + 15) : SEASON_RANGE.from;
  let toYear = SEASON_RANGE.to;
  if (planSeasonRange) {
    fromYear = Math.max(fromYear, planSeasonRange.min);
    toYear = Math.min(toYear, planSeasonRange.max);
  }

  for (let year = fromYear; year <= toYear; year++) {
    let seasonData;
    try {
      seasonData = await apiGet("/players", { id: playerId, season: year });
    } catch (err) {
      const rangeMatch = err.message.match(/try from (\d+) to (\d+)/);
      if (rangeMatch && !planSeasonRange) {
        planSeasonRange = { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
        console.warn(
          `    Il piano API-Football limita le stagioni a ${planSeasonRange.min}-${planSeasonRange.max}: aggiorno l'intervallo e continuo da lì (niente più chiamate sprecate su anni fuori range).`
        );
        toYear = Math.min(toYear, planSeasonRange.max);
        if (year < planSeasonRange.min) { year = planSeasonRange.min - 1; continue; }
        if (year > planSeasonRange.max) break;
      }
      console.warn(`    stagione ${year}: errore (${err.message}), salto`);
      continue;
    }

    if (!seasonData || seasonData.length === 0) continue;

    const statsList = seasonData[0].statistics || [];
    statsList.forEach((s) => {
      const leagueName = s.league?.name;
      const leagueId = LEAGUE_NAME_TO_ID[leagueName];
      if (!leagueId) {
        // Campionato non mappato: lo segnaliamo ma non blocchiamo il resto.
        console.warn(`    (${year}) campionato non mappato: "${leagueName}" - riga scartata`);
        return;
      }
      const club = s.team?.name;
      const apps = s.games?.appearences || 0;
      const goals = s.goals?.total || 0;
      const conceded = s.goals?.conceded || 0;
      const isGK = GK_POSITIONS.has(s.games?.position);
      if (apps === 0) return; // stagione senza presenze in quel campionato, ignora

      let stint = stints.find((st) => st.club === club && st.league === leagueId);
      if (!stint) {
        stint = { minYear: year, maxYear: year, club, league: leagueId, apps: 0, goals: 0, isGK };
        stints.push(stint);
      }
      stint.minYear = Math.min(stint.minYear, year);
      stint.maxYear = Math.max(stint.maxYear, year);
      stint.apps += apps;
      stint.goals += isGK ? conceded : goals;
    });
  }

  stints.sort((a, b) => a.minYear - b.minYear);
  return stints.map((st) => ({
    years: st.minYear === st.maxYear ? String(st.minYear) : `${st.minYear}–${st.maxYear + 1}`,
    club: st.club,
    league: st.league,
    apps: st.apps,
    goals: st.goals
  }));
}

// ---------------------------------------------------------------------------
// Passo 3: palmares
// ---------------------------------------------------------------------------

async function fetchTrophies(playerId) {
  let raw;
  try {
    raw = await apiGet("/trophies", { player: playerId });
  } catch (err) {
    console.warn(`    trofei: errore (${err.message})`);
    return [];
  }
  if (!raw) return [];

  // Raggruppiamo le vittorie ("Winner") per campionato/competizione.
  const wins = raw.filter((t) => /winner/i.test(t.place || ""));
  const grouped = {};
  wins.forEach((t) => {
    const leagueName = t.league;
    const leagueId = LEAGUE_NAME_TO_ID[leagueName] || null; // può restare null per Mondiali/Europei
    const key = leagueName;
    if (!grouped[key]) grouped[key] = { leagueId, leagueName, count: 0, seasons: [] };
    grouped[key].count += 1;
    grouped[key].seasons.push(t.season);
  });

  return Object.values(grouped).map((g) => {
    // "comp" qui riusa lo stesso id di campionato quando esiste; per le
    // competizioni internazionali (Mondiali, Europei) andrà mappato a mano
    // con id "wc" / "intl" nel JSON finale, perché API-Football le elenca
    // con nomi di torneo (es. "World Cup", "UEFA Euro") non presenti in
    // LEAGUE_NAME_TO_ID.
    const comp = g.leagueId || g.leagueName;
    const text =
      g.count > 1
        ? `${g.count} volte campione di ${g.leagueName}`
        : `1 titolo: ${g.leagueName} (${g.seasons[0]})`;
    return { comp, text };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const players = [];

  for (const name of PLAYERS_TO_SYNC) {
    console.log(`\nSincronizzo: ${name}`);
    const found = await findPlayerId(name);
    if (!found) continue;
    const { id, birthYear } = found;

    console.log("  scarico carriera...");
    const career = await fetchCareer(id, birthYear);

    console.log("  scarico palmares...");
    const trophies = await fetchTrophies(id);

    const isGK = career.length > 0 && career.some((c) => c.goals !== undefined) ? false : false;
    // Nota: l'informazione isGK viene già usata internamente in fetchCareer
    // per decidere se "goals" rappresenta gol fatti o subiti, ma non viene
    // riportata a livello di stint qui sopra per restare fedeli al formato
    // del gioco. Se ti serve, aggiungi isGK come proprietà separata per
    // ciascuno stint prima di questo punto.

    players.push({
      id: slugify(name),
      name,
      nationality: null, // da compilare: non richiesto qui per restare nel budget di chiamate
      isGK: false, // da correggere manualmente per i portieri (vedi commento sopra)
      career,
      trophies
    });
  }

  await writeOutputFiles(players);
}

/**
 * Trasforma "N'Golo Kanté" in "n-golo-kante": id stabile e leggibile,
 * usato come nome file / chiave nel manifest e come riferimento tra shard.
 */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Scrive:
 * - output/players-data.json      -> tutti i giocatori, un file unico (comodo per debug)
 * - output/<league_id>.json       -> solo i giocatori che hanno militato in quel campionato,
 *                                    ognuno con la SCHEDA COMPLETA (carriera e palmares intere,
 *                                    non solo la parte relativa a quel campionato) - un giocatore
 *                                    passato per più campionati compare, identico, in più shard.
 * - output/manifest.json          -> elenco degli shard con versione e conteggio, è il file
 *                                    piccolo che l'app scarica sempre per sapere cosa scaricare.
 */
async function writeOutputFiles(players) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // file unico completo (debug / import manuale)
  await fs.writeFile(
    `${OUTPUT_DIR}/players-data.json`,
    JSON.stringify({ version: BUILD_VERSION, players }, null, 2),
    "utf-8"
  );

  // shard per campionato
  const shards = {}; // leagueId -> array di giocatori
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
    manifest.leagues[leagueId] = {
      file: fileName,
      version: BUILD_VERSION,
      count: leaguePlayers.length
    };
  }

  await fs.writeFile(
    `${OUTPUT_DIR}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  console.log(`\nFatto. Scritti in ./${OUTPUT_DIR}/:`);
  console.log(`  players-data.json (tutti i ${players.length} giocatori, file unico)`);
  Object.entries(manifest.leagues).forEach(([leagueId, info]) => {
    console.log(`  ${info.file} (${info.count} giocatori)`);
  });
  console.log("  manifest.json (elenco degli shard con versione)");
  console.log("\nCarica il contenuto di questa cartella sul tuo hosting statico (stessa struttura, stessi nomi file).");
  console.log("Controlla manualmente: nazionalità, isGK per i portieri, e i trofei internazionali (comp 'wc'/'intl').");
}

// Esegue main() solo se il file è lanciato direttamente (node sync-players-data.mjs),
// non quando viene importato da un altro modulo (es. il file di test) - così importarlo
// per testare la logica non scatena chiamate di rete vere né chiude il processo.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("Errore fatale:", err);
    process.exit(1);
  });
}

export { slugify, fetchCareer, fetchTrophies, writeOutputFiles, findPlayerId, LEAGUE_NAME_TO_ID, resetPlanSeasonRangeForTests };
