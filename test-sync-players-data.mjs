/**
 * test-sync-players-data.mjs
 * ----------------------------------------------------------------------------
 * Test della LOGICA di sync-players-data.mjs, senza rete: sostituisce
 * global.fetch con risposte finte modellate sulla forma reale delle
 * risposte di API-Football (v3.football.api-sports.io), così possiamo
 * verificare che l'aggregazione carriera/palmares e la generazione degli
 * shard funzionino, senza bisogno di una chiave API vera.
 *
 * NON verifica: che i nomi dei campi finti coincidano al 100% con quelli
 * reali dell'API (per quello serve una chiave vera, vedi il testing manuale
 * descritto in fondo). Verifica solo che, DATI quei campi, la nostra logica
 * di aggregazione produca il risultato corretto.
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
  fetchCareer,
  fetchTrophies,
  writeOutputFiles
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

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: body, errors: {} })
  };
}

// ---------------------------------------------------------------------------
// Finti dati "API-Football" per un giocatore con due stagioni nella stessa
// squadra (Serie A) e una terza stagione in un'altra squadra/campionato.
// Forma basata sulla documentazione dell'endpoint /players.
// ---------------------------------------------------------------------------

function fakePlayersSeasonResponse({ team, leagueName, apps, goals, position = "Attacker", conceded = 0 }) {
  return [
    {
      player: { id: 999, name: "Test Player" },
      statistics: [
        {
          team: { id: 1, name: team },
          league: { name: leagueName, country: "Italy", season: 2020 },
          games: { appearences: apps, position },
          goals: { total: goals, conceded }
        }
      ]
    }
  ];
}

async function main() {
  console.log("slugify()");
  await test("accenti e apostrofi diventano trattini", () => {
    assert.equal(slugify("N'Golo Kanté"), "n-golo-kante");
    assert.equal(slugify("Zinedine Zidane"), "zinedine-zidane");
  });

  console.log("\nfetchCareer() - aggregazione stagioni sulla stessa squadra");
  await test("due stagioni nella stessa squadra si sommano in un solo stint", async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      const yearMatch = String(url).match(/season=(\d+)/);
      const year = Number(yearMatch[1]);
      if (year === 2020) {
        return jsonResponse(fakePlayersSeasonResponse({ team: "Juventus", leagueName: "Serie A", apps: 30, goals: 10 }));
      }
      if (year === 2021) {
        return jsonResponse(fakePlayersSeasonResponse({ team: "Juventus", leagueName: "Serie A", apps: 28, goals: 8 }));
      }
      return jsonResponse([]); // nessun dato per le altre stagioni controllate
    };

    process.env.API_FOOTBALL_KEY = "fake-key-for-tests";
    const career = await fetchCareer(999);

    assert.equal(career.length, 1, "ci si aspetta un solo stint (stessa squadra, stesso campionato)");
    assert.equal(career[0].club, "Juventus");
    assert.equal(career[0].league, "seriea");
    assert.equal(career[0].apps, 58, "presenze: 30 + 28");
    assert.equal(career[0].goals, 18, "gol: 10 + 8");
    assert.ok(callCount > 0, "apiGet deve essere stato chiamato almeno una volta");
  });

  await test("cambio squadra a metà carriera produce due stint separati", async () => {
    global.fetch = async (url) => {
      const yearMatch = String(url).match(/season=(\d+)/);
      const year = Number(yearMatch[1]);
      if (year === 2020) {
        return jsonResponse(fakePlayersSeasonResponse({ team: "Parma", leagueName: "Serie A", apps: 20, goals: 2 }));
      }
      if (year === 2021) {
        return jsonResponse(fakePlayersSeasonResponse({ team: "Bayern Monaco", leagueName: "Bundesliga", apps: 15, goals: 1 }));
      }
      return jsonResponse([]);
    };
    const career = await fetchCareer(999);
    assert.equal(career.length, 2);
    assert.deepEqual(career.map((c) => c.club), ["Parma", "Bayern Monaco"]);
    assert.deepEqual(career.map((c) => c.league), ["seriea", "bundesliga"]);
  });

  await test("un portiere: 'goals' nello stint è gol subiti, non fatti", async () => {
    global.fetch = async (url) => {
      const yearMatch = String(url).match(/season=(\d+)/);
      const year = Number(yearMatch[1]);
      if (year === 2020) {
        return jsonResponse(
          fakePlayersSeasonResponse({ team: "Parma", leagueName: "Serie A", apps: 34, goals: 0, position: "Goalkeeper", conceded: 41 })
        );
      }
      return jsonResponse([]);
    };
    const career = await fetchCareer(999);
    assert.equal(career.length, 1);
    assert.equal(career[0].goals, 41, "per i portieri ci aspettiamo i gol subiti, non quelli fatti (0)");
  });

  await test("campionato non mappato viene scartato senza bloccare gli altri", async () => {
    global.fetch = async (url) => {
      const yearMatch = String(url).match(/season=(\d+)/);
      const year = Number(yearMatch[1]);
      if (year === 2020) {
        return jsonResponse([
          {
            player: { id: 999, name: "Test Player" },
            statistics: [
              { team: { name: "Juventus" }, league: { name: "Serie A" }, games: { appearences: 10, position: "Attacker" }, goals: { total: 1 } },
              { team: { name: "Club Sconosciuto" }, league: { name: "Campionato Non Mappato" }, games: { appearences: 5, position: "Attacker" }, goals: { total: 0 } }
            ]
          }
        ]);
      }
      return jsonResponse([]);
    };
    const career = await fetchCareer(999);
    assert.equal(career.length, 1, "solo lo stint mappato deve comparire");
    assert.equal(career[0].club, "Juventus");
  });

  console.log("\nfetchTrophies() - raggruppamento vittorie");
  await test("più vittorie nello stesso campionato si raggruppano con il conteggio", async () => {
    global.fetch = async () =>
      jsonResponse([
        { league: "Serie A", country: "Italy", season: "2018/2019", place: "Winner" },
        { league: "Serie A", country: "Italy", season: "2019/2020", place: "Winner" },
        { league: "Serie A", country: "Italy", season: "2020/2021", place: "2nd Place" }, // non vinta, va ignorata
        { league: "Coppa Italia", country: "Italy", season: "2020/2021", place: "Winner" }
      ]);
    const trophies = await fetchTrophies(999);
    const seriea = trophies.find((t) => t.text.includes("Serie A"));
    const coppa = trophies.find((t) => t.text.includes("Coppa Italia"));
    assert.ok(seriea, "deve esserci una riga per la Serie A");
    assert.match(seriea.text, /2 volte campione/, "due vittorie -> testo con il conteggio");
    assert.ok(coppa, "deve esserci una riga per la Coppa Italia");
    assert.match(coppa.text, /1 titolo/, "una sola vittoria -> testo singolare con la stagione");
    assert.equal(trophies.length, 2, "il 2nd Place non deve generare una riga");
  });

  console.log("\nwriteOutputFiles() - shard per campionato + manifest");
  await test("un giocatore multi-campionato compare, identico, in più shard", async () => {
    const players = [
      {
        id: "player-a",
        name: "Player A",
        nationality: "Italia",
        isGK: false,
        career: [
          { years: "2015–2018", club: "Parma", league: "seriea", apps: 90, goals: 10 },
          { years: "2018–2022", club: "Bayern Monaco", league: "bundesliga", apps: 120, goals: 40 }
        ],
        trophies: [{ comp: "bundesliga", text: "1 titolo: Bundesliga (2020)" }]
      },
      {
        id: "player-b",
        name: "Player B",
        nationality: "Spagna",
        isGK: false,
        career: [{ years: "2010–2020", club: "Real Madrid", league: "laliga", apps: 300, goals: 50 }],
        trophies: []
      }
    ];

    const tmpDir = "output-test-tmp";
    const originalCwd = process.cwd();
    await fs.mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);
    try {
      await writeOutputFiles(players);

      const manifest = JSON.parse(await fs.readFile("output/manifest.json", "utf-8"));
      assert.ok(manifest.leagues.seriea, "manifest deve elencare seriea");
      assert.ok(manifest.leagues.bundesliga, "manifest deve elencare bundesliga");
      assert.ok(manifest.leagues.laliga, "manifest deve elencare laliga");
      assert.equal(manifest.leagues.seriea.count, 1);
      assert.equal(manifest.leagues.bundesliga.count, 1);
      assert.equal(manifest.leagues.laliga.count, 1);

      const seriea = JSON.parse(await fs.readFile("output/seriea.json", "utf-8"));
      const bundesliga = JSON.parse(await fs.readFile("output/bundesliga.json", "utf-8"));
      assert.equal(seriea.players[0].id, "player-a");
      assert.equal(bundesliga.players[0].id, "player-a");
      assert.deepEqual(
        seriea.players[0].career,
        bundesliga.players[0].career,
        "la scheda di Player A deve essere IDENTICA (carriera intera) in entrambi gli shard"
      );

      const full = JSON.parse(await fs.readFile("output/players-data.json", "utf-8"));
      assert.equal(full.players.length, 2, "il file unico deve contenere tutti i giocatori");
    } finally {
      process.chdir(originalCwd);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${failures === 0 ? "Tutti i test passati." : failures + " test falliti."}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
