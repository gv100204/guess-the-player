// ---------------------------------------------------------------------------
// verify-against-wikipedia.mjs
//
// Confronta i giocatori già arricchiti (careerBackfilled=true) in
// raw-players.json con la loro pagina Wikipedia, e salva un VERDETTO
// permanente per ciascuno ("ok" o "fail") in un file a parte,
// wikipedia-check.json - non tocca mai raw-players.json.
//
// Il file dei verdetti è ANCHE il checkpoint: un giocatore già controllato
// non viene ricontrollato al lancio successivo, quindi puoi interrompere
// questo script in qualunque momento (chiusura del Mac, Wi-Fi che cade,
// Ctrl+C) senza perdere il lavoro già fatto - riparte da dove si era
// fermato, non da zero.
//
// REGOLA DEL VERDETTO (decisa insieme):
//   FALLISCE se manca più del 30% delle tappe Wikipedia, OPPURE se manca
//   una tappa "nel mezzo" (non la prima, non l'ultima) - un buco a metà
//   carriera nasconde più informazione di uno all'inizio o alla fine.
//   Una tappa INIZIALE mancante viene segnalata (utile indizio di
//   nazionalità/provenienza) ma non fa fallire da sola.
//   Una tappa FINALE mancante viene ignorata quasi del tutto.
//
// LIMITE IMPORTANTE: richiede una connessione a Internet vera (interroga
// wikipedia.org) - non è mai stato testato contro Wikipedia reale da qui,
// l'ambiente dove scrivo il codice non ha accesso alla rete. Il formato
// della scheda carriera non è identico su ogni pagina - aspettati qualche
// aggiustamento dopo l'uso vero.
//
// NON corregge nulla in automatico e NON esclude nessuno da solo: scrive
// solo il verdetto. Un secondo passaggio, dentro sync-players-data.mjs,
// legge questo file (se esiste) e decide chi escludere dal gioco - così il
// controllo resta un pezzo a parte, staccato dal sync automatico.
//
// Uso:
//   node verify-against-wikipedia.mjs <N|all> [raw-players.json] [wikipedia-check.json]
//
//   node verify-against-wikipedia.mjs 15        -> controlla 15 giocatori
//                                                   NON ancora controllati
//   node verify-against-wikipedia.mjs all        -> controlla TUTTI i
//                                                   giocatori ancora da
//                                                   controllare (può durare
//                                                   ore - interrompibile e
//                                                   riprendibile in ogni
//                                                   momento)
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";

const rawArg = process.argv[2] || "15";
const RAW_FILE = process.argv[3] || "./raw-players.json";
const CHECK_FILE = process.argv[4] || "./wikipedia-check.json";
const FULL_SCAN = rawArg.toLowerCase() === "all";
const SAMPLE_SIZE = FULL_SCAN ? Infinity : (Number(rawArg) || 15);
const REQUEST_DELAY_MS = 4000; // alzato ancora da 2000ms: i 429 restavano frequenti anche così in un run prolungato
const USER_AGENT = "guess-the-player-data-check/1.0 (uso personale, non commerciale)";
const MISSING_FRACTION_THRESHOLD = 0.3;
const SAVE_EVERY_N_PLAYERS = 1; // salva dopo OGNI giocatore: è il checkpoint

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wikiFetch(url) {
  const MAX_ATTEMPTS = 6; // alzato da 3: nella scansione completa i 429 sono più frequenti del previsto
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      // Se Wikipedia dice esplicitamente quanto aspettare (intestazione
      // Retry-After), usiamo quel numero invece di indovinare - più
      // affidabile del backoff fisso che avevamo prima.
      const retryAfterHeader = res.headers.get("retry-after");
      const waitSeconds = retryAfterHeader ? Number(retryAfterHeader) : attempt * 15;
      console.log(`  (Wikipedia troppo trafficata, aspetto ${waitSeconds}s e riprovo...)`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    throw new Error(`Wikipedia ha risposto ${res.status}`);
  }
}

async function findWikipediaTitle(playerName) {
  const query = encodeURIComponent(playerName);
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${query}&limit=3&namespace=0&format=json`;
  const data = await wikiFetch(url);
  const titles = data[1] || [];
  if (titles.length === 0) return null;
  const footballerTitle = titles.find((t) => /footballer/i.test(t));
  return footballerTitle || titles[0];
}

async function fetchWikitext(title) {
  const query = encodeURIComponent(title);
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${query}&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await wikiFetch(url);
  const pages = data.query?.pages || {};
  const page = Object.values(pages)[0];
  return page?.revisions?.[0]?.slots?.main?.["*"] || null;
}

function parseSeniorCareer(wikitext) {
  if (!wikitext) return [];
  const nationalIdx = wikitext.search(/\|\s*nationalyears\d*\s*=/i);
  const clubSection = nationalIdx >= 0 ? wikitext.slice(0, nationalIdx) : wikitext;

  const years = {};
  const teams = {};
  const caps = {};
  const goals = {};
  const yearsRe = /\|\s*years(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const teamRe = /\|\s*(?:clubs|team)(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const capsRe = /\|\s*caps(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const goalsRe = /\|\s*goals(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  let m;
  while ((m = yearsRe.exec(clubSection))) years[m[1]] = m[2].trim();
  while ((m = teamRe.exec(clubSection))) teams[m[1]] = m[2].trim();
  while ((m = capsRe.exec(clubSection))) caps[m[1]] = m[2].trim();
  while ((m = goalsRe.exec(clubSection))) goals[m[1]] = m[2].trim();

  const entries = [];
  for (const idx of Object.keys(years)) {
    if (!teams[idx]) continue;
    const yearRange = parseYearRange(years[idx]);
    const teamName = cleanWikiMarkup(teams[idx]);
    const capsNum = caps[idx] != null ? Number((caps[idx].match(/\d+/) || [])[0]) : null;
    const goalsNum = goals[idx] != null ? Number((goals[idx].match(/\d+/) || [])[0]) : null;
    if (capsNum === 0) continue;
    if (yearRange && teamName) {
      entries.push({ team: teamName, from: yearRange.from, to: yearRange.to, apps: capsNum || null, goals: goalsNum ?? 0 });
    }
  }
  return entries.sort((a, b) => a.from - b.from);
}

function parseYearRange(raw) {
  const nums = raw.match(/\d{4}/g);
  if (!nums || nums.length === 0) return null;
  const from = Number(nums[0]);
  const to = nums.length > 1 ? Number(nums[nums.length - 1]) : from;
  return { from, to };
}

function cleanWikiMarkup(raw) {
  return raw
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^→\s*/, "")
    .replace(/\s*\((loan|on loan|dual registration)\)\s*/gi, "")
    .trim();
}

function isCovered(wikiEntry, seasonRecords) {
  const wikiClub = wikiEntry.team.toLowerCase();
  return seasonRecords.some((r) => {
    const ourClub = (r.club || "").toLowerCase();
    if (!ourClub || ourClub === "squadra sconosciuta") return false;
    const nameMatches = ourClub.includes(wikiClub) || wikiClub.includes(ourClub);
    if (!nameMatches) return false;
    return r.season >= wikiEntry.from - 1 && r.season <= wikiEntry.to + 1;
  });
}

// Calcola il verdetto secondo la regola concordata: fallisce se manca più
// del 30% delle tappe, oppure se manca una tappa "nel mezzo" (non la prima,
// non l'ultima, in ordine cronologico degli anni Wikipedia).
function computeVerdict(wikiEntries, seasonRecords) {
  if (wikiEntries.length === 0) return null; // impossibile giudicare, niente da confrontare
  const lastIdx = wikiEntries.length - 1;

  const missing = [];
  wikiEntries.forEach((e, i) => {
    if (isCovered(e, seasonRecords)) return;
    let position;
    if (wikiEntries.length === 1) position = "unica";
    else if (i === 0) position = "iniziale";
    else if (i === lastIdx) position = "finale";
    else position = "centrale";
    missing.push({ team: e.team, from: e.from, to: e.to, position, apps: e.apps, goals: e.goals });
  });

  const missingFraction = missing.length / wikiEntries.length;
  const hasMissingMiddle = missing.some((m) => m.position === "centrale" || m.position === "unica");
  const fail = missingFraction > MISSING_FRACTION_THRESHOLD || hasMissingMiddle;

  return { fail, missing, totalEntries: wikiEntries.length, missingFraction };
}

function pickCandidates(players, checked) {
  const backfilled = players.filter((p) => p.careerBackfilled && !checked[p.id]);
  const old = backfilled.filter((p) => p.birthYear && p.birthYear < 1990);
  const rest = backfilled.filter((p) => !p.birthYear || p.birthYear >= 1990);
  const shuffledOld = [...old].sort(() => Math.random() - 0.5);
  const shuffledRest = [...rest].sort(() => Math.random() - 0.5);
  if (FULL_SCAN) return [...shuffledOld, ...shuffledRest];
  const halfOld = Math.ceil(SAMPLE_SIZE / 2);
  return [...shuffledOld.slice(0, halfOld), ...shuffledRest.slice(0, SAMPLE_SIZE - halfOld)];
}

async function loadCheckFile() {
  try {
    const raw = await fs.readFile(CHECK_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { checked: {} };
  }
}

async function saveCheckFile(data) {
  await fs.writeFile(CHECK_FILE, JSON.stringify(data, null, 2), "utf-8");
}

async function main() {
  const raw = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
  const players = raw.players || [];
  const checkData = await loadCheckFile();

  const alreadyChecked = Object.keys(checkData.checked).length;
  const candidates = pickCandidates(players, checkData.checked);

  console.log(`Già controllati in precedenza: ${alreadyChecked}`);
  console.log(`Da controllare in questo lancio: ${candidates.length}${FULL_SCAN ? " (scansione completa)" : ""}\n`);

  let checkedNow = 0;
  let notFoundOnWikipedia = 0;
  let failed = 0;

  for (const p of candidates) {
    try {
      const title = await findWikipediaTitle(p.name);
      await sleep(REQUEST_DELAY_MS);
      if (!title) {
        console.log(`? ${p.name}: nessuna pagina Wikipedia trovata, salto (non salvato: riprovabile in futuro)`);
        notFoundOnWikipedia++;
        continue;
      }

      const wikitext = await fetchWikitext(title);
      await sleep(REQUEST_DELAY_MS);
      const wikiEntries = parseSeniorCareer(wikitext);

      if (wikiEntries.length === 0) {
        console.log(`? ${p.name} (${title}): non riesco a leggere la scheda carriera, salto`);
        continue;
      }

      const verdict = computeVerdict(wikiEntries, p.seasonRecords || []);
      checkData.checked[p.id] = {
        name: p.name,
        wikipediaTitle: title,
        verdict: verdict.fail ? "fail" : "ok",
        missingFraction: Math.round(verdict.missingFraction * 100) / 100,
        missing: verdict.missing,
        checkedAt: new Date().toISOString()
      };
      checkedNow++;

      if (verdict.fail) {
        failed++;
        console.log(`✗ ${p.name} (${title}) - FALLISCE (${Math.round(verdict.missingFraction * 100)}% mancante):`);
        verdict.missing.forEach((e) => {
          const years = e.from === e.to ? String(e.from) : `${e.from}-${e.to}`;
          console.log(`    [${e.position}] ${e.team} (${years})`);
        });
      } else if (verdict.missing.length > 0) {
        console.log(`✓ ${p.name}: passa (manca solo la tappa iniziale/finale, non conta)`);
      } else {
        console.log(`✓ ${p.name}: tutte le tappe Wikipedia trovate`);
      }

      if (checkedNow % SAVE_EVERY_N_PLAYERS === 0) await saveCheckFile(checkData);
    } catch (err) {
      console.log(`? ${p.name}: errore (${err.message}), salto (non salvato: riprovabile in futuro)`);
    }
  }

  await saveCheckFile(checkData); // salvataggio finale, per sicurezza

  console.log("\n" + "=".repeat(60));
  console.log(`Controllati in questo lancio: ${checkedNow} / ${candidates.length}`);
  console.log(`Non trovati su Wikipedia: ${notFoundOnWikipedia}`);
  console.log(`Falliti (verranno esclusi dal gioco): ${failed}`);
  console.log(`Totale verdetti salvati finora: ${Object.keys(checkData.checked).length}`);
  console.log(`\nSalvato in: ${CHECK_FILE}`);
  if (!FULL_SCAN) {
    console.log("Rilancia con lo stesso comando per controllarne altri (salta chi è già fatto).");
  }
}

main();
