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

  console.log("\ngetActiveLeagues() / getSeasonRange() - scope ridotto per i lanci di test");
  await test("senza variabili d'ambiente, restituisce tutto il catalogo", () => {
    delete process.env.SYNC_LEAGUES;
    assert.equal(getActiveLeagues().length, LEAGUES_TO_SYNC.length);
  });
  await test("con SYNC_LEAGUES impostata, restringe ai soli campionati indicati", () => {
    process.env.SYNC_LEAGUES = "seriea, laliga";
    const active = getActiveLeagues();
    assert.deepEqual(active.map((l) => l.id), ["seriea", "laliga"]);
    delete process.env.SYNC_LEAGUES;
  });
  await test("con SYNC_SEASON_FROM/TO impostate, restringe la finestra di stagioni", () => {
    process.env.SYNC_SEASON_FROM = "2015";
    process.env.SYNC_SEASON_TO = "2016";
    const range = getSeasonRange();
    assert.deepEqual(range, { from: 2015, to: 2016 });
    delete process.env.SYNC_SEASON_FROM;
    delete process.env.SYNC_SEASON_TO;
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
  await test("il nome per esteso si ricostruisce da firstname+lastname, non dalla forma abbreviata 'name' (bug reale: usciva 'L. Messi')", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 10, name: "L. Messi", firstname: "Lionel", lastname: "Messi", nationality: "Argentina" },
      statistics: [{ team: { name: "Barcellona" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 30, position: "Attacker" }, goals: { total: 20 } }]
    };
    mergePlayerEntry(players, entry, 2020);
    assert.equal(players.get(10).name, "Lionel Messi");
  });

  await test("senza firstname/lastname, ripiega sul campo 'name' così com'è", () => {
    const players = newPlayersMap();
    const entry = {
      player: { id: 11, name: "Solo Nome", nationality: "Italy" },
      statistics: [{ team: { name: "Team" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 10, position: "Attacker" }, goals: { total: 1 } }]
    };
    mergePlayerEntry(players, entry, 2020);
    assert.equal(players.get(11).name, "Solo Nome");
  });

  await test("un giocatore già salvato con nome abbreviato si autocorregge se un passaggio successivo porta il nome per esteso", () => {
    const players = newPlayersMap();
    // prima "passata": solo il nome abbreviato (come nei dati già salvati prima del fix)
    mergePlayerEntry(players, {
      player: { id: 12, name: "L. Messi", nationality: "Argentina" },
      statistics: [{ team: { name: "Barcellona" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 10, position: "Attacker" }, goals: { total: 2 } }]
    }, 2015);
    assert.equal(players.get(12).name, "L. Messi");
    // seconda "passata" (run successivo): stavolta arriva anche il nome per esteso
    mergePlayerEntry(players, {
      player: { id: 12, name: "L. Messi", firstname: "Lionel", lastname: "Messi", nationality: "Argentina" },
      statistics: [{ team: { name: "Barcellona" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 20, position: "Attacker" }, goals: { total: 5 } }]
    }, 2016);
    assert.equal(players.get(12).name, "Lionel Messi", "il nome esistente deve autocorreggersi, non restare abbreviato");
  });

  await test("un prestito (stessa squadra, ma con un'interruzione nel mezzo) produce tappe separate, non un unico blocco che nasconde l'interruzione (bug reale segnalato dall'utente: Bologna 2015, Atalanta 2016, Bologna 2017 mostrato come 'Bologna 2015-2017')", () => {
    const players = newPlayersMap();
    const bologna = (season, apps, goals) => ({
      player: { id: 20, name: "Test Player" },
      statistics: [{ team: { name: "Bologna" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: apps, position: "Attacker" }, goals: { total: goals } }]
    });
    const atalanta = (season, apps, goals) => ({
      player: { id: 20, name: "Test Player" },
      statistics: [{ team: { name: "Atalanta" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: apps, position: "Attacker" }, goals: { total: goals } }]
    });
    mergePlayerEntry(players, bologna(2015, 20, 2), 2015);
    mergePlayerEntry(players, atalanta(2016, 5, 0), 2016);
    mergePlayerEntry(players, bologna(2017, 16, 2), 2017);

    const career = finalizeCareer(players.get(20));
    assert.equal(career.length, 3, "devono risultare TRE tappe distinte, non due (Bologna unito) o una sola");
    assert.equal(career[0].club, "Bologna"); assert.equal(career[0].years, "2015");
    assert.equal(career[1].club, "Atalanta"); assert.equal(career[1].years, "2016");
    assert.equal(career[2].club, "Bologna"); assert.equal(career[2].years, "2017");
    assert.notEqual(career[0].years, "2015–2018", "non deve fondere le due tappe al Bologna in un unico intervallo che nasconde il prestito");
  });

  await test("nessuna interruzione reale: stagioni consecutive nello stesso club restano un'unica tappa con l'intervallo giusto", () => {
    const players = newPlayersMap();
    const entryFor = (apps, goals) => ({
      player: { id: 21, name: "Test Player 2" },
      statistics: [{ team: { name: "Milan" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: apps, position: "Attacker" }, goals: { total: goals } }]
    });
    mergePlayerEntry(players, entryFor(20, 3), 2018);
    mergePlayerEntry(players, entryFor(25, 5), 2019);
    mergePlayerEntry(players, entryFor(18, 2), 2020);
    const career = finalizeCareer(players.get(21));
    assert.equal(career.length, 1);
    assert.equal(career[0].years, "2018–2021");
    assert.equal(career[0].apps, 63);
  });

  await test("un giocatore già arricchito con la carriera completa non viene più toccato dallo sweep (bug reale previsto dall'utente: rischiava di contare due volte la stessa stagione)", () => {
    const players = newPlayersMap();
    // simuliamo un giocatore già arricchito (come dopo fetchFullCareer)
    players.set(40, {
      id: 40, name: "Già Arricchito", nationality: "England", isGK: false,
      seasonRecords: [{ season: 2015, club: "Arsenal", league: "pl", leagueRaw: null, country: null, apps: 30, goals: 5 }],
      trophies: null, trophiesFetched: false, careerBackfilled: true
    });
    // lo sweep della Premier League lo ritrova nella stessa stagione
    mergePlayerEntry(players, {
      player: { id: 40, name: "Già Arricchito" },
      statistics: [{ team: { name: "Arsenal" }, league: { name: "Premier League", country: "England" }, games: { appearences: 30, position: "Attacker" }, goals: { total: 5 } }]
    }, 2015);
    const career = finalizeCareer(players.get(40));
    assert.equal(career.length, 1);
    assert.equal(career[0].apps, 30, "deve restare 30, non 60: lo sweep non deve aggiungere righe a un giocatore già arricchito");
  });

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
    assert.equal(seriea.country, null, "un campionato riconosciuto (seriea) non ha bisogno del paese per essere chiaro");
    assert.ok(coppa, "deve esserci una riga per la Coppa Italia");
    assert.equal(coppa.country, "Italy", "una competizione non riconosciuta deve portarsi dietro il paese, altrimenti resta ambigua");
  });

  await test("una 'Super Cup' vinta in due paesi diversi non si mescola in un'unica riga (bug reale segnalato dall'utente)", async () => {
    global.fetch = async () =>
      jsonResponse([
        { league: "Super Cup", country: "Italy", season: "2020", place: "Winner" },
        { league: "Super Cup", country: "Spain", season: "2021", place: "Winner" }
      ]);
    const trophies = await fetchTrophies(999);
    assert.equal(trophies.length, 2, "devono restare due righe distinte, non una sola fusa insieme");
    const it = trophies.find((t) => t.country === "Italy");
    const es = trophies.find((t) => t.country === "Spain");
    assert.ok(it && es, "una riga per l'Italia e una per la Spagna, ciascuna con il proprio paese");
    assert.equal(it.count, 1);
    assert.equal(es.count, 1);
  });

  await test("una vittoria duplicata senza stagione (bug reale: gonfiava il conteggio, es. Francesco Acerbi) non viene contata due volte", async () => {
    global.fetch = async () =>
      jsonResponse([
        { league: "Serie A", country: "Italy", season: "2023/2024", place: "Winner" },
        { league: "Serie A", country: "Italy", season: null, place: "Winner" }, // doppione della riga sopra, senza stagione
        { league: "Super Cup", country: "Italy", season: "2024", place: "Winner" },
        { league: "Super Cup", country: "Italy", season: "2023", place: "Winner" },
        { league: "Super Cup", country: "Italy", season: "2019", place: "Winner" },
        { league: "Super Cup", country: "Italy", season: null, place: "Winner" } // doppione di una delle tre sopra
      ]);
    const trophies = await fetchTrophies(999);
    const seriea = trophies.find((t) => t.comp === "seriea");
    const superCup = trophies.find((t) => t.comp === "Super Cup");
    assert.equal(seriea.count, 1, "una sola stagione vera (2023/2024): il duplicato senza stagione non deve contare");
    assert.equal(superCup.count, 3, "tre stagioni vere (2024, 2023, 2019): il duplicato senza stagione non deve portarlo a 4");
  });


  console.log("\nresolveLeagueApiIds() - risparmio con gli id già salvati");
  await test("non richiama l'API per un campionato il cui id è già salvato nel progresso (bug reale: si ricalcolava a ogni run)", async () => {
    process.env.SYNC_LEAGUES = "seriea";
    let callCount = 0;
    global.fetch = async () => { callCount++; return jsonResponse([]); };
    const budget = { remaining: 100 };
    const cachedIds = { seriea: 135 };
    await resolveLeagueApiIds(budget, cachedIds);
    assert.equal(callCount, 0, "non deve fare nessuna chiamata: l'id era già in cache");
    const seriea = getActiveLeagues().find((l) => l.id === "seriea");
    assert.equal(seriea.numericId, 135);
    delete process.env.SYNC_LEAGUES;
  });

  console.log("\nisLikelyDomesticLeague() - euristica coppe/nazionali vs campionato vero");
  await test("riconosce nomi di coppe e competizioni internazionali da escludere", () => {
    assert.equal(isLikelyDomesticLeague("FA Cup"), false);
    assert.equal(isLikelyDomesticLeague("Copa del Rey"), false);
    assert.equal(isLikelyDomesticLeague("UEFA Champions League"), false);
    assert.equal(isLikelyDomesticLeague("World Cup"), false);
    assert.equal(isLikelyDomesticLeague("Friendlies"), false);
    assert.equal(isLikelyDomesticLeague(null), false);
  });
  await test("riconosce nomi di campionati veri come da includere", () => {
    assert.equal(isLikelyDomesticLeague("Primera División"), true);
    assert.equal(isLikelyDomesticLeague("Süper Lig"), true);
    assert.equal(isLikelyDomesticLeague("Serie A"), true);
  });
  await test("scarta le nazionali (anche giovanili) in base al nome della squadra, non del campionato (bug reale segnalato dall'utente: 'UEFA U17 Championship' passava perché non somiglia a nessuna coppa)", () => {
    assert.equal(isLikelyDomesticLeague("UEFA U17 Championship", "Slovenia U17"), false);
    assert.equal(isLikelyDomesticLeague("UEFA U19 Championship", "Slovenia U19"), false);
    assert.equal(isLikelyDomesticLeague("UEFA U21 Championship", "Slovenia U21"), false);
    assert.equal(isLikelyDomesticLeague("1. SNL", "Maribor"), true, "un vero club non deve essere scartato per errore");
  });
  await test("riconosce anche i nomi per esteso delle nazionali maggiori che le sole parole chiave non coprivano ('European Championship', non 'Euro Championship')", () => {
    assert.equal(isLikelyDomesticLeague("UEFA European Championship"), false);
  });

  console.log("\nfetchFullCareer() - recupero della carriera completa, fuori dai campionati tracciati");
  await test("scarta le presenze in nazionale giovanile anche dentro il recupero completo (bug reale: comparivano mescolate nella carriera come se fossero un club)", async () => {
    global.fetch = async (url) => {
      const season = Number(new URL(url).searchParams.get("season"));
      if (season === 2011) {
        return jsonResponse([{
          player: { id: 35, name: "Test Player" },
          statistics: [
            { team: { name: "Maribor" }, league: { name: "1. SNL", country: "Slovenia" }, games: { appearences: 1, position: "Attacker" }, goals: { total: 0 } },
            { team: { name: "Slovenia U17" }, league: { name: "UEFA U17 Championship", country: "World" }, games: { appearences: 3, position: "Attacker" }, goals: { total: 0 } }
          ]
        }]);
      }
      return jsonResponse([]);
    };
    const budget = { remaining: 100 };
    const result = await fetchFullCareer(35, 1994, budget);
    assert.equal(result.records.length, 1, "solo il club vero deve comparire, non la nazionale U17");
    assert.equal(result.records[0].club, "Maribor");
  });
  await test("cattura anche un campionato estero non tracciato, con nome grezzo e paese (non lo scarta come farebbe la spazzolata normale)", async () => {
    global.fetch = async (url) => {
      const season = Number(new URL(url).searchParams.get("season"));
      if (season === 2010) {
        return jsonResponse([{
          player: { id: 30, name: "Test Player" },
          statistics: [{ team: { name: "Boca Juniors" }, league: { name: "Primera División", country: "Argentina" }, games: { appearences: 25, position: "Attacker" }, goals: { total: 8 } }]
        }]);
      }
      return jsonResponse([]);
    };

    const budget = { remaining: 100 };
    const result = await fetchFullCareer(30, 1990, budget); // birthYear 1990 -> parte dal 2005, arriva a copertura ampia
    assert.equal(result.completed, true);
    const argentina = result.records.find((r) => r.club === "Boca Juniors");
    assert.ok(argentina, "deve trovare la tappa argentina, che la spazzolata per campionato non vedrebbe mai");
    assert.equal(argentina.league, null, "non è nel nostro catalogo, quindi league resta null...");
    assert.equal(argentina.leagueRaw, "Primera División");
    assert.equal(argentina.country, "Argentina", "...ma il nome grezzo e il paese devono esserci, per poterlo mostrare comunque");
  });
  await test("scarta le righe di coppe/nazionali anche nel recupero completo", async () => {
    global.fetch = async (url) => {
      const season = Number(new URL(url).searchParams.get("season"));
      if (season === 2015) {
        return jsonResponse([{
          player: { id: 31, name: "Test Player 2" },
          statistics: [
            { team: { name: "Real Madrid" }, league: { name: "La Liga", country: "Spain" }, games: { appearences: 30, position: "Attacker" }, goals: { total: 10 } },
            { team: { name: "Real Madrid" }, league: { name: "Copa del Rey", country: "Spain" }, games: { appearences: 4, position: "Attacker" }, goals: { total: 1 } }
          ]
        }]);
      }
      return jsonResponse([]);
    };
    const budget = { remaining: 100 };
    const result = await fetchFullCareer(31, 1995, budget);
    assert.equal(result.records.length, 1, "solo la Liga deve comparire, non la Copa del Rey");
    assert.equal(result.records[0].league, "laliga", "questa invece È nel nostro catalogo, quindi league deve avere l'id interno");
  });
  await test("si ferma (senza completare) se il budget finisce a metà del recupero", async () => {
    let callCount = 0;
    global.fetch = async () => { callCount++; return jsonResponse([]); };
    const budget = { remaining: 3 };
    const result = await fetchFullCareer(32, 2000, budget); // dal 2015 al 2025 farebbe 11 chiamate, ma il budget ne concede solo 3
    assert.equal(result.completed, false);
    assert.equal(callCount, 3);
  });

  await test("si ferma dopo alcune stagioni vuote consecutive UNA VOLTA TROVATI dati reali (probabile ritiro), invece di controllare fino alla fine", async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      const season = Number(new URL(url).searchParams.get("season"));
      if (season === 2015) {
        return jsonResponse([{
          player: { id: 33, name: "Giocatore Ritirato" },
          statistics: [{ team: { name: "Milan" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 20, position: "Attacker" }, goals: { total: 3 } }]
        }]);
      }
      return jsonResponse([{ player: { id: 33, name: "Giocatore Ritirato" }, statistics: [] }]); // ritirato dal 2016 in poi
    };
    const budget = { remaining: 100 };
    // birthYear 2000 -> si parte proprio dal 2015 (2000+15): la prima stagione
    // controllata ha già i dati veri, così isoliamo l'effetto dell'arresto
    // anticipato senza mescolarlo alla fase "ancora non ha debuttato" (che è
    // giusto che costi chiamate, non è quello che stiamo misurando qui).
    // Senza l'arresto anticipato, andare dal 2015 al 2025 costerebbe 11 chiamate.
    const result = await fetchFullCareer(33, 2000, budget);
    assert.equal(result.completed, true);
    assert.ok(callCount < 11, `deve fermarsi prima del 2025 (ha fatto ${callCount} chiamate, senza il fix sarebbero state 11)`);
    assert.equal(result.records.length, 1, "la stagione vera trovata prima del ritiro deve comunque esserci");
  });

  await test("NON si ferma anticipatamente prima di aver trovato la prima stagione vera (stesso bug della vecchia euristica, da non ripetere)", async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      const season = Number(new URL(url).searchParams.get("season"));
      // debutta tardi: le prime 5 stagioni controllate sono vuote, la sesta ha dati veri
      if (season < 2020) return jsonResponse([{ player: { id: 34, name: "Debutto Tardivo" }, statistics: [] }]);
      return jsonResponse([{
        player: { id: 34, name: "Debutto Tardivo" },
        statistics: [{ team: { name: "Torino" }, league: { name: "Serie A", country: "Italy" }, games: { appearences: 15, position: "Attacker" }, goals: { total: 1 } }]
      }]);
    };
    const budget = { remaining: 100 };
    const result = await fetchFullCareer(34, 2000, budget); // parte dal 2015 (2000+15)
    const found = result.records.find((r) => r.club === "Torino");
    assert.ok(found, "deve arrivare comunque alla stagione vera del 2020, senza fermarsi prima per errore");
  });

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
      progress.leagueIds.seriea = 135; // simula un id campionato già risolto in un run precedente
      await saveProgress(progress);
      const reloadedProgress = await loadProgress();
      assert.ok(reloadedProgress.completed.has("laliga:2021"));
      assert.equal(reloadedProgress.leagueIds.seriea, 135, "anche gli id dei campionati devono persistere tra un run e l'altro (bug reale: si ricalcolavano ogni volta)");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${failures === 0 ? "Tutti i test passati." : failures + " test falliti."}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
