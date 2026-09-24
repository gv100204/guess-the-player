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
//   node verify-against-wikipedia.mjs recompute  -> NON chiama Wikipedia:
//                                                   riapplica la regola di
//                                                   verdetto ATTUALE a tutti
//                                                   i giocatori già
//                                                   controllati in passato,
//                                                   usando i dati che hai
//                                                   già raccolto - istantaneo,
//                                                   utile dopo aver cambiato
//                                                   la regola stessa
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";

const rawArg = process.argv[2] || "15";
const RAW_FILE = process.argv[3] || "./raw-players.json";
const CHECK_FILE = process.argv[4] || "./wikipedia-check.json";
const FULL_SCAN = rawArg.toLowerCase() === "all";
const RECOMPUTE = rawArg.toLowerCase() === "recompute";
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

async function searchWikipediaTitles(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&namespace=0&format=json`;
  const data = await wikiFetch(url);
  return data[1] || [];
}

// Nomi ispanici/portoghesi/etc. spesso hanno più parole di quante la
// pagina Wikipedia ne usi nel titolo (secondi nomi, doppi cognomi,
// connettivi come "i"/"y"/"de"/"van"...) - invece di indovinare quale
// convenzione culturale si applica, proviamo OGNI singola parola insieme
// alla prima. Funzione condivisa: usata sia quando la ricerca col nome
// completo non trova NULLA, sia quando trova una pagina ESISTENTE ma
// SBAGLIATA (zero tappe estratte).
const NAME_CONNECTORS = new Set(["i", "y", "e", "de", "da", "do", "del", "van", "von", "der", "la", "las", "los", "das", "dos", "du"]);
function nameCandidates(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 2) return [];
  return parts.slice(1).filter((w) => !NAME_CONNECTORS.has(w.toLowerCase())).map((w) => `${parts[0]} ${w}`);
}

async function findWikipediaTitle(playerName) {
  let titles = await searchWikipediaTitles(playerName);

  // Se il nome completo non trova nulla, proviamo ogni parola singola
  // insieme alla prima - bug reale trovato: "Hendry Bernardo Thomas
  // Suazo" non veniva trovato nemmeno provando primo+ultima ("Hendry
  // Suazo", sbagliato) - la pagina vera è "Hendry Thomas" (terza parola).
  if (titles.length === 0) {
    for (const shortName of nameCandidates(playerName)) {
      await sleep(REQUEST_DELAY_MS);
      titles = await searchWikipediaTitles(shortName);
      if (titles.length > 0) break;
    }
  }

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
  // NOTA: non tagliamo più il testo alla prima comparsa di "nationalyears"
  // come si faceva prima - bug reale trovato su Giuseppe Sculli: la pagina
  // mette le presenze in nazionale IN MEZZO alle tappe di club nel testo
  // sorgente (years1, years2, nationalyears1, nationalyears2, poi years3
  // fino a years14), quindi tagliare lì perdeva 12 tappe su 14. Non serve
  // comunque: le regex qui sotto richiedono che "years"/"clubs"/"caps"
  // arrivi SUBITO dopo il "|" (a parte gli spazi) - "nationalyears1" non le
  // fa scattare per errore, perché tra "|" e "years" c'è "national" di
  // mezzo, che \s* non salta.

  const years = {};
  const teams = {};
  const caps = {};
  const goals = {};
  const yearsRe = /\|\s*years(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const teamRe = /\|\s*(?:clubs|team)(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const capsRe = /\|\s*caps(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  const goalsRe = /\|\s*goals(\d+)\s*=\s*((?:(?!\n|\|\s*\w+\s*=).)+)/gi;
  let m;
  while ((m = yearsRe.exec(wikitext))) years[m[1]] = m[2].trim();
  while ((m = teamRe.exec(wikitext))) teams[m[1]] = m[2].trim();
  while ((m = capsRe.exec(wikitext))) caps[m[1]] = m[2].trim();
  while ((m = goalsRe.exec(wikitext))) goals[m[1]] = m[2].trim();

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
// del 30% delle tappe, oppure se manca una tappa CENTRALE o INIZIALE (solo
// una tappa FINALE mancante non fa mai fallire da sola, a prescindere dalla
// percentuale - deciso dopo aver visto Silvestre e Bojan Krkic passare con
// l'iniziale mancante: la regola è stata resa più severa apposta).
function verdictFromMissing(missing, totalEntries) {
  const missingFraction = missing.length / totalEntries;
  const hasFailingPosition = missing.some((m) => m.position !== "finale");
  const fail = missingFraction > MISSING_FRACTION_THRESHOLD || hasFailingPosition;
  return { fail, missing, totalEntries, missingFraction };
}

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

  return verdictFromMissing(missing, wikiEntries.length);
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
  const checkData = await loadCheckFile();

  if (RECOMPUTE) {
    // Nessuna chiamata a Wikipedia, e non serve nemmeno raw-players.json:
    // per ogni giocatore già controllato in passato, riapplichiamo la
    // regola ATTUALE ai dati (squadra/anni/presenze delle tappe mancanti)
    // che avevamo già salvato allora - utile dopo aver cambiato la regola
    // stessa, senza dover rifare ore di richieste di rete già fatte una volta.
    let changed = 0;
    for (const [, entry] of Object.entries(checkData.checked)) {
      const missing = entry.missing || [];
      const totalEntries = entry.missingFraction != null && missing.length > 0
        ? Math.round(missing.length / entry.missingFraction)
        : missing.length; // se mancava tutto (fraction=1) o non c'era nulla di mancante
      const verdict = verdictFromMissing(missing, totalEntries || 1);
      const newVerdict = verdict.fail ? "fail" : "ok";
      if (entry.verdict !== newVerdict) {
        console.log(`${entry.name}: ${entry.verdict} -> ${newVerdict}`);
        entry.verdict = newVerdict;
        changed++;
      }
    }
    await saveCheckFile(checkData);
    console.log(`\nRicalcolati: ${Object.keys(checkData.checked).length}`);
    console.log(`Verdetto cambiato per: ${changed}`);
    return;
  }

  const raw = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
  const players = raw.players || [];

  const alreadyChecked = Object.keys(checkData.checked).length;
  const candidates = pickCandidates(players, checkData.checked);

  console.log(`Già controllati in precedenza: ${alreadyChecked}`);
  console.log(`Da controllare in questo lancio: ${candidates.length}${FULL_SCAN ? " (scansione completa)" : ""}\n`);

  let checkedNow = 0;
  let notFoundOnWikipedia = 0;
  let unreadable = 0; // pagina trovata ma zero tappe estratte, anche dopo tutti i tentativi
  let failed = 0;
  let processedIdx = 0;

  function printProgress() {
    const all = Object.values(checkData.checked);
    const totalOk = all.filter((e) => e.verdict === "ok").length;
    const totalFail = all.filter((e) => e.verdict === "fail").length;
    const pct = ((processedIdx / candidates.length) * 100).toFixed(1);
    const totalNotFound = notFoundOnWikipedia + unreadable;
    console.log(`  [${processedIdx}/${candidates.length} in questo lancio, ${pct}% | totale finora: ${totalOk} ok, ${totalFail} fail, ${totalNotFound} non trovati (${notFoundOnWikipedia} pagina assente, ${unreadable} non leggibile)]`);
  }

  for (const p of candidates) {
    processedIdx++;
    try {
      const title = await findWikipediaTitle(p.name);
      await sleep(REQUEST_DELAY_MS);
      if (!title) {
        console.log(`? ${p.name}: nessuna pagina Wikipedia trovata, salto (non salvato: riprovabile in futuro)`);
        notFoundOnWikipedia++;
        printProgress();
        continue;
      }

      let wikitext = await fetchWikitext(title);
      await sleep(REQUEST_DELAY_MS);
      let wikiEntries = parseSeniorCareer(wikitext);

      // Prima di arrenderci, riproviamo fino a 2 volte in più, con attesa
      // crescente: test su pagine reali (Pastore, Guarín, Romero) hanno
      // confermato che il parser legge bene questi formati - zero tappe è
      // quasi sempre una risposta sfortunata dovuta al traffico, non un
      // vero problema di pagina. Un solo ritentativo non bastava quando la
      // pressione è sostenuta (confermato: Romero ha fallito 2 volte di
      // fila anche con un ritentativo).
      for (let retry = 1; wikiEntries.length === 0 && retry <= 2; retry++) {
        const waitS = retry * 6;
        console.log(`  (${p.name}: zero tappe trovate, aspetto ${waitS}s e riprovo [${retry}/2]...)`);
        await sleep(waitS * 1000);
        wikitext = await fetchWikitext(title);
        await sleep(REQUEST_DELAY_MS);
        wikiEntries = parseSeniorCareer(wikitext);
      }

      // Ultima risorsa: se il nome ha più di 2 parole e ancora zero tappe,
      // la ricerca col nome completo potrebbe aver trovato una pagina
      // ESISTENTE ma SBAGLIATA (non vuota, quindi il tentativo di riserva
      // di findWikipediaTitle non scattava mai) - proviamo esplicitamente
      // gli stessi candidati (stessa funzione nameCandidates usata sopra),
      // con un titolo potenzialmente diverso.
      if (wikiEntries.length === 0) {
        for (const shortName of nameCandidates(p.name)) {
          if (wikiEntries.length > 0) break;
          console.log(`  (${p.name}: ancora zero tappe, provo il nome corto "${shortName}"...)`);
          const shortTitles = await searchWikipediaTitles(shortName);
          await sleep(REQUEST_DELAY_MS);
          const shortTitle = shortTitles.find((t) => /footballer/i.test(t)) || shortTitles[0];
          if (shortTitle && shortTitle !== title) {
            wikitext = await fetchWikitext(shortTitle);
            await sleep(REQUEST_DELAY_MS);
            wikiEntries = parseSeniorCareer(wikitext);
          }
        }
      }

      if (wikiEntries.length === 0) {
        console.log(`? ${p.name} (${title}): non riesco a leggere la scheda carriera, salto`);
        unreadable++;
        printProgress();
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
        console.log(`✓ ${p.name}: passa (manca solo la tappa finale, non conta)`);
      } else {
        console.log(`✓ ${p.name}: tutte le tappe Wikipedia trovate`);
      }
      printProgress();

      if (checkedNow % SAVE_EVERY_N_PLAYERS === 0) await saveCheckFile(checkData);
    } catch (err) {
      console.log(`? ${p.name}: errore (${err.message}), salto (non salvato: riprovabile in futuro)`);
      printProgress();
    }
  }

  await saveCheckFile(checkData); // salvataggio finale, per sicurezza

  console.log("\n" + "=".repeat(60));
  console.log(`Controllati in questo lancio: ${checkedNow} / ${candidates.length}`);
  console.log(`Nessuna pagina Wikipedia trovata: ${notFoundOnWikipedia}`);
  console.log(`Pagina trovata ma non leggibile: ${unreadable}`);
  console.log(`Falliti (verranno esclusi dal gioco): ${failed}`);
  console.log(`Totale verdetti salvati finora: ${Object.keys(checkData.checked).length}`);
  console.log(`\nSalvato in: ${CHECK_FILE}`);
  if (!FULL_SCAN) {
    console.log("Rilancia con lo stesso comando per controllarne altri (salta chi è già fatto).");
  }
}

main();
