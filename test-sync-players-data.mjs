/**
 * test-sync-players-data.mjs
 * ----------------------------------------------------------------------------
 * Test della LOGICA di sync-players-data.mjs, senza rete: sostituisce
 * global.fetch con risposte finte modellate sulla forma reale delle
 * risposte di API-Football (v3.football.api-sports.io).
 *
 * NON verifica: che i nomi dei campi finti coincidano al 100% con quelli
 * reali dell'API. Verifica che, DATI quei campi, la nostra logica di
 * aggregazione, disambiguazione campionati e gestione del budget di
 * chiamate funzioni correttamente.
 *
 * Uso: node test-sync-players-data.mjs
 * ----------------------------------------------------------------------------
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";

process.env.SYNC_RATE_LIMIT_DELAY_MS = "0"; // nei test non serve rispettare i rate limit reali
process.env.API_FOOTBALL_KEY = "fake-key-for-tests";

import {
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
  loadRawPlayers,
  saveRawPlayers,
  loadProgress,
  saveProgress,
  LEAGUES_TO_SYNC,
  resetPlanSeasonRangeForTests
} from "./sync-players-data.mjs";

let failures = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK  ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    });
}

function jsonResponse(body, paging) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: body, errors: {}, paging: paging || { current: 1, total: 1 } })
  };
}

function newPlayersMap() {
  return new Map();
}

async function main() {
  console.log("slugify()");
  await test("accenti e apostrofi diventano trattini", () => {
    assert.equal(slugify("N'Golo Kanté"), "n-golo-kante");
  });

  console.log("\nmatchLeague() - disambiguazione per nome + paese");
  await test("la Serie A italiana si risolve correttamente; un omonimo di un campionato non tracciato (Brasileirão, tolto per adesso) no", () => {
    var it = matchLeague("Serie A", "Italy");
    var br = matchLeague("Serie A", "Brazil");
    assert.ok(it, "la Serie A italiana deve essere trovata");
    assert.equal(it.id, "seriea");
    assert.equal(br, undefined, "il Brasileirão non è nel catalogo attuale: non deve risolversi, e soprattutto non deve confondersi con la Serie A italiana");
  });
  await test("un nome che non corrisponde a nessun campionato tracciato restituisce undefined", () => {
    assert.equal(matchLeague("Coppa Italia", "Italy"), undefined);
  });

  console.log("\nmergePlayerEntry() - aggregazione carriera");
  await test("due stagioni nello stesso club/campionato si aggregano in un solo stint", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 1, name: "Test Player", nationality: "Italy" },
      statistics: [{ team: { name: "Juventus" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 30, position: "Attacker" }, goals: { total: 10 } }]
    };
    mergePlayerEntry(players, entry, 2020);
    mergePlayerEntry(players, entry, 2021);
    const rec = players.get(1);
    const career = finalizeCareer(rec);
    assert.equal(career.length, 1);
    assert.equal(career[0].apps, 60);
    assert.equal(career[0].goals, 20);
    assert.equal(career[0].league, "seriea");
  });

  await test("una riga di un campionato non tracciato (Brasileirão) non finisce per errore nella Serie A italiana", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 2, name: "Giocatore Brasiliano", nationality: "Brazil" },
      statistics: [{ team: { name: "Flamengo" }, league: { name: "Serie A", country: "Brazil" }, games: { appearences: 20, position: "Attacker" }, goals: { total: 5 } }]
    };
    mergePlayerEntry(players, entry, 2020);
    const career = finalizeCareer(players.get(2));
    assert.equal(career.length, 0, "il Brasileirão non è nel catalogo attuale: la riga va scartata, non confusa con la Serie A italiana");
  });

  await test("un portiere: 'goals' nello stint è gol subiti, non fatti", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 3, name: "Portiere Test", nationality: "Spain" },
      statistics: [{ team: { name: "Real Sociedad" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 34, position: "Goalkeeper" }, goals: { total: 0, conceded: 41 } }]
    };
    mergePlayerEntry(players, entry, 2021);
    const rec = players.get(3);
    assert.equal(rec.isGK, true);
    assert.equal(finalizeCareer(rec)[0].goals, 41);
  });

  await test("una competizione non tracciata (coppa, amichevole) viene scartata silenziosamente", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 4, name: "Test Player 2", nationality: "England" },
      statistics: [
        { team: { name: "Arsenal" }, league: { name: "Premier League", country: "England" }, games: { appearences: 25, position: "Midfielder" }, goals: { total: 3 } },
        { team: { name: "Arsenal" }, league: { name: "FA Cup", country: "England" }, games: { appearences: 4, position: "Midfielder" }, goals: { total: 1 } }
      ]
    };
    mergePlayerEntry(players, entry, 2022);
    assert.equal(finalizeCareer(players.get(4)).length, 1, "solo la Premier League deve comparire, non la FA Cup");
  });

  console.log("\nsweepLeagueSeason() - paginazione e budget di chiamate");
  await test("segue la paginazione finché non arriva all'ultima pagina", async () => {
    resetPlanSeasonRangeForTests();
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      const page = Number(new URL(url).searchParams.get("page"));
      const body = [{
        player: { id: 100 + page, name: "Player " + page, nationality: "Italy" },
        statistics: [{ team: { name: "Team" + page }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 15, position: "Attacker" }, goals: { total: 2 } }]
      }];
      return jsonResponse(body, { current: page, total: 3 });
    };
    const players = newPlayersMap();
    const league = { id: "seriea", apiName: "Serie A", country: "Italy", numericId: 135 };
    const budget = { remaining: 100 };
    const result = await sweepLeagueSeason(league, 2023, players, budget);
    assert.equal(result.completed, true);
    assert.equal(callCount, 3, "deve chiamare tutte e 3 le pagine");
    assert.equal(players.size, 3, "deve aver trovato un giocatore per pagina");
  });

  await test("si ferma a metà (senza segnare completato) se il budget finisce durante la paginazione, con reason 'budget'", async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse([], { current: page, total: 5 });
    };
    const players = newPlayersMap();
    const league = { id: "seriea", apiName: "Serie A", country: "Italy", numericId: 135 };
    const budget = { remaining: 2 }; // basta solo per 2 delle 5 pagine
    const result = await sweepLeagueSeason(league, 2023, players, budget);
    assert.equal(result.completed, false, "non deve segnarsi come completata se si ferma a metà");
    assert.equal(result.reason, "budget", "il motivo deve essere 'budget', non un errore generico");
    assert.equal(callCount, 2, "non deve fare più chiamate di quelle nel budget");
  });

  await test("un errore isolato (non di budget, non di limite stagioni) restituisce reason 'error', non 'budget' (bug reale: fermava tutto il run per un solo errore)", async () => {
    global.fetch = async () => { throw new Error("Connessione di rete interrotta"); };
    const players = newPlayersMap();
    const league = { id: "seriea", apiName: "Serie A", country: "Italy", numericId: 135 };
    const budget = { remaining: 100 };
    const result = await sweepLeagueSeason(league, 2023, players, budget);
    assert.equal(result.completed, false);
    assert.equal(result.reason, "error", "un errore isolato deve poter essere distinto da un budget esaurito, così chi chiama sa che può continuare con le altre combinazioni invece di fermare tutto");
  });

  console.log("\nfetchTrophies() - raggruppamento vittorie (dati puri, non più frasi in italiano)");
  await test("più vittorie nello stesso campionato si raggruppano con conteggio e stagioni, senza costruire frasi", async () => {
    global.fetch = async () =>
      jsonResponse([
        { league: "Serie A", country: "Italy", season: "2018/2019", place: "Winner" },
        { league: "Serie A", country: "Italy", season: "2019/2020", place: "Winner" },
        { league: "Serie A", country: "Italy", season: "2020/2021", place: "2nd Place" },
        { league: "Coppa Italia", country: "Italy", season: "2020/2021", place: "Winner" }
      ]);
    const trophies = await fetchTrophies(999);
    const seriea = trophies.find((t) => t.comp === "seriea");
    const coppa = trophies.find((t) => t.comp === "Coppa Italia"); // non nel catalogo LEAGUES_TO_SYNC: resta il nome grezzo
    assert.ok(seriea, "deve esserci una riga per la Serie A");
    assert.equal(seriea.count, 2, "due vittorie -> count 2, non una frase");
    assert.deepEqual(seriea.seasons, ["2018/2019", "2019/2020"]);
    assert.equal(typeof seriea.text, "undefined", "non deve più esserci un campo 'text' pre-scritto in italiano");
    assert.ok(coppa, "deve esserci una riga per la Coppa Italia");
    assert.equal(coppa.count, 1);
    assert.equal(trophies.length, 2, "il 2nd Place non deve generare una riga");
  });

  console.log("\nbuildFinalDataset() - filtro sulla soglia minima di presenze");
  await test("un giocatore sotto la soglia minima viene escluso dal dataset finale", () => {
    const players = newPlayersMap();
    mergePlayerEntry(players, {
      player: { id: 5, name: "Comparsa", nationality: "Italy" },
      statistics: [{ team: { name: "Team X" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 2, position: "Attacker" }, goals: { total: 0 } }]
    }, 2020);
    mergePlayerEntry(players, {
      player: { id: 6, name: "Titolare", nationality: "Italy" },
      statistics: [{ team: { name: "Team Y" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 150, position: "Attacker" }, goals: { total: 20 } }]
    }, 2020);
    const final = buildFinalDataset(players);
    assert.equal(final.length, 1, "solo il titolare deve superare la soglia MIN_APPS_TO_INCLUDE");
    assert.equal(final[0].name, "Titolare");
  });

  console.log("\nPersistenza tra run (raw-players.json, sync-progress.json)");
  await test("i giocatori grezzi salvati si ricaricano identici (round-trip)", async () => {
    const tmpDir = "persist-test-tmp";
    await fs.mkdir(tmpDir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const players = newPlayersMap();
      mergePlayerEntry(players, {
        player: { id: 7, name: "Da Salvare", nationality: "Spain" },
        statistics: [{ team: { name: "Club Salvato" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 40, position: "Defender" }, goals: { total: 1 } }]
      }, 2021);

      await saveRawPlayers(players);
      const reloaded = await loadRawPlayers();
      const rec = reloaded.get(7);
      assert.ok(rec, "il giocatore deve essere ricaricato");
      assert.equal(finalizeCareer(rec)[0].apps, 40);

      const progress = await loadProgress();
      progress.completed.add("laliga:2021");
      await saveProgress(progress);
      const reloadedProgress = await loadProgress();
      assert.ok(reloadedProgress.completed.has("laliga:2021"));
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${failures === 0 ? "Tutti i test passati." : failures + " test falliti."}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
