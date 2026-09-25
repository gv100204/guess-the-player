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

// Verifica che la pagina trovata sia DAVVERO quella giusta, non solo "ha
// abbastanza tappe". Bug reale trovato: la ricerca del mononimo "José" (da
// solo) trovava sempre "Josue (footballer, born 1987)" - un brasiliano
// oscuro con 10 tappe, abbastanza per superare la soglia minima, ma NIENTE
// a che vedere con Callejón/Jurado/Ulloa/eccetera. La ricerca fuzzy di
// Wikipedia puo' agganciare nomi simili ma diversi, quindi tante tappe da
// sole non bastano a fidarsi.
function normalizeWord(w) {
  return (w || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function titleLooksRelated(query, title) {
  const qFirst = normalizeWord(query.trim().split(/\s+/)[0]);
  const tFirst = normalizeWord(title.replace(/\s*\(.*?\)\s*$/, "").trim().split(/\s+/)[0]);
  if (!qFirst || !tFirst) return true;
  return qFirst === tFirst || qFirst.startsWith(tFirst) || tFirst.startsWith(qFirst);
}

function extractBirthYear(wikitext) {
  if (!wikitext) return null;
  const m = wikitext.match(/\{\{\s*[Bb]irth date(?: and age)?\s*\|[^}]*?(\d{4})/);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1900 && year <= 2025 ? year : null;
}

function isTrustworthyMatch(query, title, wikitext, expectedBirthYear) {
  if (!titleLooksRelated(query, title)) return false;
  if (expectedBirthYear) {
    const pageBirthYear = extractBirthYear(wikitext);
    if (pageBirthYear && pageBirthYear !== expectedBirthYear) return false;
  }
  return true;
}

// Nomi ispanici/portoghesi/etc. spesso hanno più parole di quante la
// pagina Wikipedia ne usi nel titolo - invece di indovinare quale
// convenzione culturale si applica, generiamo diversi candidati plausibili
// e li proviamo in ordine. Funzione condivisa: usata sia quando la ricerca
// col nome completo non trova NULLA, sia quando trova una pagina
// ESISTENTE ma SBAGLIATA (zero tappe estratte). Pattern coperti (tutti
// trovati su casi reali, non ipotizzati a tavolino):
//   - mononimo, solo la prima parola (es. "Joaquín", noto così in Spagna)
//   - mononimo con disambiguante (es. "Maxwell (footballer)" - "Maxwell"
//     da solo è troppo comune, la ricerca nuda trova la disambiguazione)
//   - prima parola + una successiva (secondo nome/doppio cognome/parola
//     mai usata pubblicamente, es. "Henrikh Mkhitaryan", "Henry Giménez")
//   - due parole adiacenti che NON includono la prima (es. "Anton Ciprian
//     Tătărușanu" -> "Ciprian Tătărușanu", "Anton" mai usato pubblicamente)
//   - ordine invertito per nomi di 2 parole (convenzione coreana: cognome
//     PRIMA, es. i nostri dati hanno "Ji-Sung Park", il titolo vero è
//     "Park Ji-sung")
const NAME_CONNECTORS = new Set(["i", "y", "e", "de", "da", "do", "del", "van", "von", "der", "la", "las", "los", "das", "dos", "du"]);
function nameCandidates(fullName, birthYear) {
  const candidates = [];

  // Omonimia: se esiste più di un calciatore/persona con lo stesso nome,
  // Wikipedia disambigua con "(footballer, born ANNO)" - dato che abbiamo
  // già l'anno di nascita nei nostri dati, costruiamo il candidato esatto
  // invece di indovinare. Vale per QUALUNQUE nome, anche di 2 parole (es.
  // "Michael Turner", che senza questo non generava nessun tentativo -
  // esiste anche un "Mike Turner" più anziano, la ricerca nuda trovava
  // solo la pagina di disambiguazione, senza scheda carriera da leggere).
  if (birthYear) candidates.push(`${fullName} (footballer, born ${birthYear})`);
  candidates.push(`${fullName} (footballer)`);

  const parts = fullName.trim().split(/\s+/).filter((w) => !NAME_CONNECTORS.has(w.toLowerCase()));

  if (parts.length === 2) {
    candidates.push(`${parts[1]} ${parts[0]}`); // ordine invertito (coreano)
  }

  if (parts.length > 2) {
    candidates.push(parts[0]); // mononimo
    if (birthYear) candidates.push(`${parts[0]} (footballer, born ${birthYear})`);
    candidates.push(`${parts[0]} (footballer)`); // mononimo + disambiguante
    for (let i = 1; i < parts.length; i++) candidates.push(`${parts[0]} ${parts[i]}`); // prima + ciascuna altra
    for (let i = 1; i < parts.length - 1; i++) candidates.push(`${parts[i]} ${parts[i + 1]}`); // coppie senza la prima
  }

  return candidates;
}

async function findWikipediaTitle(playerName, birthYear) {
  let titles = await searchWikipediaTitles(playerName);
  let query = playerName;

  // Se il nome completo non trova nulla, proviamo i candidati generati
  // sopra (disambiguante con anno, mononimo, ricombinazioni delle parole).
  if (titles.length === 0) {
    for (const shortName of nameCandidates(playerName, birthYear)) {
      await sleep(REQUEST_DELAY_MS);
      titles = await searchWikipediaTitles(shortName);
      if (titles.length > 0) {
        query = shortName;
        break;
      }
    }
  }

  if (titles.length === 0) return null;
  // Scartiamo i titoli che non sembrano nemmeno imparentati col nome
  // cercato (bug reale: "José" -> agganciato a "Josue", nome simile ma
  // diverso). Se dopo il filtro non resta nulla, meglio ripiegare sul
  // primo risultato grezzo che restituire null - verrà comunque ricontrollato
  // più avanti quando proviamo a leggere la pagina.
  const related = titles.filter((t) => titleLooksRelated(query, t));
  const pool = related.length > 0 ? related : titles;
  const footballerTitle = pool.find((t) => /footballer/i.test(t));
  return footballerTitle || pool[0];
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
  const notFoundNames = [];
  const unreadableNames = [];
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
      let title = await findWikipediaTitle(p.name, p.birthYear);
      await sleep(REQUEST_DELAY_MS);
      if (!title) {
        console.log(`? ${p.name}: nessuna pagina Wikipedia trovata, salto (non salvato: riprovabile in futuro)`);
        notFoundOnWikipedia++;
        notFoundNames.push(p.name);
        printProgress();
        continue;
      }

      let wikitext = await fetchWikitext(title);
      await sleep(REQUEST_DELAY_MS);
      let wikiEntries = parseSeniorCareer(wikitext);

      // Anche se ha trovato delle tappe, controlliamo che la pagina sia
      // DAVVERO quella giusta (nome imparentato + anno di nascita, se
      // disponibile) - bug reale: "José" da solo si agganciava sempre a
      // "Josue (footballer, born 1987)", un'altra persona con 10 tappe
      // proprie, accettata per errore solo perché il numero era alto.
      if (wikiEntries.length > 0 && !isTrustworthyMatch(p.name, title, wikitext, p.birthYear)) {
        console.log(`  (${p.name}: pagina trovata (${title}) non sembra la persona giusta, la scarto e riprovo...)`);
        wikiEntries = [];
      }

      // Prima di arrenderci, riproviamo UNA volta: test su pagine reali
      // (Pastore, Guarín, Romero) hanno confermato che il parser legge
      // bene questi formati - zero tappe è spesso una risposta sfortunata
      // dovuta al traffico, non un vero problema di pagina. Un solo
      // ritentativo (invece di due) è un compromesso: risparmia ~12-14s
      // per caso, accettando che sotto pressione molto sostenuta possa
      // ancora capitare di dover passare ai nomi corti inutilmente.
      if (wikiEntries.length === 0) {
        console.log(`  (${p.name}: zero tappe trovate, aspetto 8s e riprovo...)`);
        await sleep(8000);
        wikitext = await fetchWikitext(title);
        await sleep(REQUEST_DELAY_MS);
        wikiEntries = parseSeniorCareer(wikitext);
        if (wikiEntries.length > 0 && !isTrustworthyMatch(p.name, title, wikitext, p.birthYear)) {
          wikiEntries = [];
        }
      }

      // Ultima risorsa: se il nome ha più di 2 parole e ancora zero tappe,
      // la ricerca col nome completo potrebbe aver trovato una pagina
      // ESISTENTE ma SBAGLIATA (non vuota, quindi il tentativo di riserva
      // di findWikipediaTitle non scattava mai) - proviamo esplicitamente
      // gli stessi candidati (stessa funzione nameCandidates usata sopra),
      // con un titolo potenzialmente diverso. Ogni candidato deve anche
      // superare isTrustworthyMatch (nome imparentato + anno di nascita se
      // disponibile) prima di essere considerato "il migliore" - bug reale
      // trovato: il mononimo "José" si agganciava sempre a "Josue
      // (footballer, born 1987)", un'altra persona con 10 tappe proprie,
      // accettata per errore per Callejón/Jurado/Ulloa/eccetera solo
      // perché il numero di tappe era alto.
      if (wikiEntries.length === 0) {
        let bestEntries = [];
        let bestTitle = null;
        const MIN_ACCEPTABLE = 3; // sotto questa soglia, continuiamo a cercare un candidato migliore invece di accontentarci
        for (const shortName of nameCandidates(p.name, p.birthYear)) {
          if (bestEntries.length >= MIN_ACCEPTABLE) break;
          console.log(`  (${p.name}: ancora zero tappe, provo il nome corto "${shortName}"...)`);
          const shortTitles = await searchWikipediaTitles(shortName);
          await sleep(REQUEST_DELAY_MS);
          const relevantTitles = shortTitles.filter((t) => titleLooksRelated(shortName, t));
          const shortTitle = relevantTitles.find((t) => /footballer/i.test(t)) || relevantTitles[0];
          if (shortTitle && shortTitle !== title) {
            const candidateWikitext = await fetchWikitext(shortTitle);
            await sleep(REQUEST_DELAY_MS);
            const candidateEntries = parseSeniorCareer(candidateWikitext);
            const trustworthy = candidateEntries.length > 0 && isTrustworthyMatch(shortName, shortTitle, candidateWikitext, p.birthYear);
            if (trustworthy && candidateEntries.length > bestEntries.length) {
              bestEntries = candidateEntries;
              bestTitle = shortTitle;
              wikitext = candidateWikitext;
            }
          }
        }
        if (bestEntries.length > 0) {
          wikiEntries = bestEntries;
          title = bestTitle; // aggiorno anche il titolo, cosi' il log finale mostra quello giusto
        }
      }

      if (wikiEntries.length === 0) {
        console.log(`? ${p.name} (${title}): non riesco a leggere la scheda carriera, salto`);
        unreadable++;
        unreadableNames.push(`${p.name} (${title})`);
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

  // Elenco dei non trovati/non leggibili di QUESTO lancio, salvato su file:
  // quello che scorre nel terminale non resta da nessuna parte una volta
  // chiuso, questo file invece si può riguardare con calma (o mandare a
  // Claude per indagare altri casi, come fatto finora).
  if (notFoundNames.length > 0 || unreadableNames.length > 0) {
    const lines = [
      `Report del ${new Date().toISOString()}`,
      "",
      `Nessuna pagina trovata (${notFoundNames.length}):`,
      ...notFoundNames.map((n) => `  ${n}`),
      "",
      `Pagina trovata ma non leggibile (${unreadableNames.length}):`,
      ...unreadableNames.map((n) => `  ${n}`)
    ];
    await fs.writeFile("./wikipedia-unresolved.txt", lines.join("\n"), "utf-8");
    console.log(`Elenco dei non trovati/non leggibili salvato in: ./wikipedia-unresolved.txt`);
  }

  if (!FULL_SCAN) {
    console.log("Rilancia con lo stesso comando per controllarne altri (salta chi è già fatto).");
  }
}

main();
