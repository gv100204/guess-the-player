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
const REVALIDATE = rawArg.toLowerCase() === "revalidate";
const REVERDICT = rawArg.toLowerCase() === "reverdict";
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
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      // Errore di rete generico (connessione interrotta, timeout, DNS...),
      // non una risposta HTTP con un codice preciso - bug reale trovato:
      // questi errori saltavano fuori dal ciclo di ritentativi senza mai
      // essere riprovati, a differenza dei 429 che venivano gestiti bene.
      if (attempt < MAX_ATTEMPTS) {
        const waitSeconds = attempt * 10;
        console.log(`  (errore di rete (${err.message}), aspetto ${waitSeconds}s e riprovo...)`);
        await sleep(waitSeconds * 1000);
        continue;
      }
      throw err;
    }
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

// Ricerca a TESTO PIENO (cerca dentro il contenuto delle pagine, non solo
// nei titoli come opensearch) - utile quando il nome completo compare
// nell'infobox ("fullname = ...") ma il titolo della pagina è un
// soprannome o una forma abbreviata diversa (es. "Yannick Anister Sagbo-
// Latte" nei nostri dati, ma la pagina si chiama solo "Yannick Sagbo" -
// opensearch sui titoli non lo trova, la ricerca a testo pieno sì, perché
// "Sagbo-Latte" compare comunque nel testo della pagina).
async function fullTextSearchTitles(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`;
  const data = await wikiFetch(url);
  return (data?.query?.search || []).map((r) => r.title);
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

// Il campo "fullname" dell'infobox contiene il nome legale completo,
// indipendentemente dal titolo della pagina - utile quando il titolo è un
// soprannome (es. "Pepe Reina") ma il nome cercato è quello legale (es.
// "José Manuel Reina Páez"): il titolo non assomiglia per niente al nome
// cercato, ma il campo fullname sì, parola per parola.
function extractFullNameField(wikitext) {
  if (!wikitext) return null;
  const m = wikitext.match(/\|\s*fullname\s*=\s*([^\n|]+)/i);
  if (!m) return null;
  return m[1]
    .replace(/<ref[^>]*\/>|<ref[^>]*>.*?<\/ref>/gi, "") // blocco intero, non solo il tag
    .replace(/\{\{[^}]*\}\}|\[\[([^\]|]+\|)?([^\]]+)\]\]|<[^>]+>|\[\d+\]/g, "$2")
    .replace(/"/g, "")
    .trim();
}

// Distanza di Levenshtein (numero minimo di caratteri da cambiare per
// passare da una stringa all'altra) - standard, senza libreria esterna.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

// Vero se il nome intero (tutte le parole, non solo un candidato corto)
// e il titolo differiscono solo per pochi caratteri - varianti di
// ortografia/traslitterazione vicine, come "Vassilis" vs "Vasilis"
// Torosidis, o "Andrii" vs "Andriy" Yarmolenko: stessa persona, scritta
// diversamente da noi e da Wikipedia. Confrontiamo le parole intere
// concatenate (non solo la prima), perché a volte è una parola successiva
// ad avere la differenza, non la prima. Soglia stretta (2 caratteri, o il
// 10% della lunghezza) e lunghezza minima di 10, per non aprire scorciatoie
// pericolose su nomi corti: "José" (4 lettere) dista solo 1 carattere da
// "Josue", un'altra persona reale - qui la soglia lo lascerebbe passare,
// motivo per cui questo controllo va usato SOLO insieme alla conferma
// dell'anno di nascita nella funzione chiamante, mai da solo.
function namesAreCloseVariant(fullName, title) {
  const a = fullName.trim().split(/\s+/).map(normalizeWord).join("");
  const b = title.replace(/\s*\(.*?\)\s*$/, "").trim().split(/\s+/).map(normalizeWord).join("");
  if (a.length < 10 || b.length < 10) return false;
  const threshold = Math.max(2, Math.round(Math.max(a.length, b.length) * 0.1));
  return levenshtein(a, b) <= threshold;
}

// Vero se OGNI parola del nome cercato compare, per intero, tra le parole
// del campo fullname - più severo di titleLooksRelated (basta un prefisso
// della prima parola), ma qui possiamo permettercelo: il fullname è testo
// libero scritto apposta per essere il nome legale completo, non un
// titolo abbreviato per forza.
function fullNameFieldMatches(query, wikitext) {
  const fullname = extractFullNameField(wikitext);
  if (!fullname) return false;
  const fullnameWords = new Set(fullname.split(/\s+/).map(normalizeWord));
  return query.trim().split(/\s+/).every((w) => fullnameWords.has(normalizeWord(w)));
}

function isTrustworthyMatch(query, title, wikitext, expectedBirthYear, requireNameMatch = true, fullPlayerName = null) {
  if (requireNameMatch) {
    const nameOk = titleLooksRelated(query, title) || fullNameFieldMatches(query, wikitext);
    if (!nameOk) {
      // Ultima possibilità: variante di ortografia vicina, ma SOLO se
      // l'anno di nascita è noto e combacia - altrimenti troppo rischioso
      // (vedi il caso José/Josue, a un solo carattere di differenza ma
      // persone diverse: senza la conferma dell'anno non ci si può fidare).
      const pageBirthYear = extractBirthYear(wikitext);
      const closeSpelling =
        expectedBirthYear &&
        fullPlayerName &&
        pageBirthYear === expectedBirthYear &&
        namesAreCloseVariant(fullPlayerName, title);
      if (!closeSpelling) return false;
    }
  }
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
    // Versioni CON disambiguante prima: sono più precise (costruiscono
    // esattamente il formato che Wikipedia usa per gli omonimi) e quindi
    // meno a rischio di agganciare la persona sbagliata per pura
    // coincidenza di nome+anno. Il mononimo NUDO (senza disambiguante) va
    // provato per ultimo tra questi, perché è il più rischioso - bug reale
    // trovato: il mononimo nudo "Luis" si agganciava a "Luisma (footballer,
    // born 1989)", un'altra persona reale nata nello stesso identico anno
    // per pura coincidenza, superando anche il controllo anno di nascita.
    // Se "Luis Hernández (footballer, born 1989)" (primo+secondo parola +
    // disambiguante) fosse stato provato PRIMA, avrebbe trovato la persona
    // giusta senza mai arrivare al mononimo rischioso.
    if (birthYear) candidates.push(`${parts[0]} ${parts[1]} (footballer, born ${birthYear})`);
    candidates.push(`${parts[0]} ${parts[1]} (footballer)`);
    if (birthYear) candidates.push(`${parts[0]} (footballer, born ${birthYear})`);
    candidates.push(`${parts[0]} (footballer)`);
    candidates.push(parts[0]); // mononimo nudo - ultima risorsa tra questi, il più rischioso

    for (let i = 1; i < parts.length; i++) candidates.push(`${parts[0]} ${parts[i]}`); // prima + ciascuna altra
    for (let i = 1; i < parts.length - 1; i++) candidates.push(`${parts[i]} ${parts[i + 1]}`); // coppie senza la prima

    // Cognomi composti col trattino: a volte Wikipedia usa solo la prima
    // metà, scartando quella dopo il trattino - bug reale trovato: "Sagbo-
    // Latte" (cognome vero) diventa solo "Sagbo" su Wikipedia ("Yannick
    // Sagbo"), ma la parola intera "Sagbo-Latte" non produce mai "Sagbo"
    // da solo perché divido il nome solo sugli spazi, non sui trattini.
    for (const w of parts.slice(1)) {
      if (!w.includes("-")) continue;
      for (const sub of w.split("-")) {
        if (sub) candidates.push(`${parts[0]} ${sub}`);
      }
    }
  }

  return candidates;
}

// Cerca il titolo E legge la pagina in UNA chiamata sola, invece di due
// separate (prima searchWikipediaTitles, poi fetchWikitext) con una pausa
// di 4 secondi in mezzo. MediaWiki lo permette con "generator=search":
// combina la ricerca a testo pieno con la lettura del contenuto nella
// stessa risposta. Per il caso semplice (la maggioranza dei giocatori,
// dove il primo tentativo trova subito la pagina giusta) questo dimezza
// sia le chiamate di rete sia l'attesa tra l'una e l'altra.
async function searchAndFetchWikitext(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&redirects=1&prop=revisions&rvprop=content&rvslots=main&format=json`;
  const data = await wikiFetch(url);
  const pages = data.query?.pages || {};
  const page = Object.values(pages)[0];
  if (!page) return { title: null, wikitext: null };
  return {
    title: page.title || null,
    wikitext: page.revisions?.[0]?.slots?.main?.["*"] || null
  };
}

async function findWikipediaTitle(playerName, birthYear) {
  let titles = await searchWikipediaTitles(playerName);
  let query = playerName;
  let fromFullText = false;

  // Se il nome completo non trova nulla, proviamo prima la ricerca a
  // testo pieno (trova pagine dove il nome vero compare nell'infobox
  // anche se il titolo è un soprannome/forma abbreviata), poi i candidati
  // generati sopra (disambiguante con anno, mononimo, ricombinazioni).
  if (titles.length === 0) {
    titles = await fullTextSearchTitles(playerName);
    await sleep(REQUEST_DELAY_MS);
    if (titles.length > 0) fromFullText = true;
  }

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
  // più avanti quando proviamo a leggere la pagina. Per i risultati della
  // ricerca a testo pieno saltiamo questo filtro: lì il punto è proprio
  // trovare titoli che NON assomigliano al nome (soprannomi come "Pepe"
  // per "José") - il nome compare comunque nel contenuto della pagina.
  const pool = fromFullText ? titles : (() => {
    const related = titles.filter((t) => titleLooksRelated(query, t));
    return related.length > 0 ? related : titles;
  })();
  const footballerTitle = pool.find((t) => /footballer/i.test(t));
  return footballerTitle || pool[0];
}

async function fetchWikitext(title) {
  const query = encodeURIComponent(title);
  // redirects=1: se il titolo cercato è in realtà un reindirizzamento
  // (es. "José Andrés Guardado Hernández" -> "Andrés Guardado"), l'API lo
  // segue da sola e restituisce il contenuto vero della pagina di
  // destinazione - senza questo parametro si ottiene solo la riga
  // "#REDIRECT [[...]]", zero tappe, e nessun campo "fullname" da leggere.
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${query}&redirects=1&prop=revisions&rvprop=content&rvslots=main&format=json`;
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

// Nomi dei club: la fonte dati (api-football) e Wikipedia li scrivono in
// modo diverso - senza accenti ("Atletico Madrid", "Cadiz", "Sporting
// Gijon"), senza trattini ("Paris Saint Germain", "Saint Etienne"), con
// sigle ("QPR") o in tedesco ("Bayern München" vs "Bayern Munich"). Il
// vecchio confronto (solo minuscole + includes) li considerava club
// diversi, quindi tappe presenti nei nostri dati risultavano "mancanti":
// una parte grossa dei "fail" era falsa per questo. Qui sotto togliamo
// accenti e punteggiatura, e teniamo una piccola tabella di alias, con
// SOLO le coppie viste davvero nei nostri dati (le altre vanno aggiunte
// dopo averle verificate, non ipotizzate).
const CLUB_ALIASES = new Map([
  // Già visti nei dati all'inizio
  ["qpr", "queens park rangers"],
  ["bayern munchen", "bayern munich"],
  // Ricavati con mine-club-aliases.mjs dai dati veri e controllati a mano
  // (nome nella nostra fonte -> nome su Wikipedia). Ogni riga ha almeno
  // ~50% dei casi con lo stesso nome nostro, senza ambiguità.
  ["wolves", "wolverhampton wanderers"],
  ["olympiakos piraeus", "olympiacos"],
  ["athletic club", "athletic bilbao"],
  ["vitoria sc", "vitoria guimaraes"],        // "Vitória SC" è il nome ufficiale del Guimarães
  ["sheffield utd", "sheffield united"],
  ["atletico mg", "atletico mineiro"],
  ["tsv 1860 munchen", "1860 munich"],
  ["1899 hoffenheim", "tsg hoffenheim"],
  ["sparta praha", "sparta prague"],
  ["fk crvena zvezda", "red star belgrade"],
  ["cfr 1907 cluj", "cfr cluj"],
  ["uniao de leiria", "uniao leiria"],
  ["legia warszawa", "legia warsaw"],
  ["los angeles galaxy", "la galaxy"],
  // Squadre RISERVE dove il nome del club cambia oltre al suffisso (la
  // regola B = II sotto copre da sola quelle dove cambia solo il suffisso).
  // ATTENZIONE: qui si mappa il nome della RISERVA, mai quello della prima
  // squadra - il miner li aveva proposti al contrario ("athletic club" ->
  // "bilbao athletic", "celta vigo" -> "celta b") perché molti giocatori
  // passano dalla B alla prima squadra negli stessi anni.
  ["athletic club ii", "bilbao athletic"],
  ["celta de vigo ii", "celta ii"]            // "celta ii" = "Celta B" dopo la regola B = II
]);
const LETTER_FIXES = { "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss" };
function normClub(s) {
  let base = (s || "")
    .toLowerCase()
    .replace(/[øæœłđðþß]/g, (c) => LETTER_FIXES[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "") // "Newell's" e "Newells" devono coincidere: l'apostrofo si toglie, non diventa uno spazio
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // Squadre B: Wikipedia scrive "Real Madrid B", la nostra fonte "Real
  // Madrid II" (stessa cosa per Valencia, Atlético, Espanyol, Betis...:
  // visto in sette club diversi, sempre come nome più frequente).
  base = base.replace(/ b$/, " ii");
  return CLUB_ALIASES.get(base) || base;
}

// Una squadra riserva (B/C, nei nostri dati "II"/"III") è una tappa DIVERSA
// dalla prima squadra: le squadre B e C vanno tenute nelle carriere, quindi
// le presenze in prima squadra non devono "coprire" una tappa alla B degli
// stessi anni (e viceversa). Prima il confronto "un nome contiene l'altro"
// li confondeva: "real madrid ii" contiene "real madrid", quindi un buco
// alla B risultava coperto dalla prima squadra e non veniva mai riparato.
function isReserveClub(normName) {
  return / (ii|iii|c)$/.test(normName);
}

function isCovered(wikiEntry, seasonRecords) {
  const wikiClub = normClub(wikiEntry.team);
  if (!wikiClub) return false;
  const wikiIsReserve = isReserveClub(wikiClub);
  return seasonRecords.some((r) => {
    const ourClub = normClub(r.club);
    if (!ourClub || ourClub === "squadra sconosciuta") return false;
    if (isReserveClub(ourClub) !== wikiIsReserve) return false;
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

// Scrittura sicura: prima su un file temporaneo, poi rinominato. Se il
// processo viene interrotto a metà (Ctrl+C, crash), il file vero resta
// intero invece di ritrovarsi troncato. Le scritture sono accodate una
// dietro l'altra, così due salvataggi ravvicinati (es. quello periodico e
// quello di Ctrl+C) non si pestano i piedi sullo stesso file temporaneo.
let writeChain = Promise.resolve();
function writeJsonAtomic(file, data) {
  const json = JSON.stringify(data, null, 2); // fotografia dei dati ADESSO
  writeChain = writeChain.then(async () => {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, json, "utf-8");
    await fs.rename(tmp, file);
  });
  return writeChain;
}

async function saveCheckFile(data) {
  await writeJsonAtomic(CHECK_FILE, data);
}

// Carriera COMPLETA letta da Wikipedia, una riga per giocatore, aggiunta
// subito dopo ogni controllo. Prima salvavamo solo l'elenco delle tappe
// "mancanti", quindi ogni volta che cambiavamo una regola (confronto dei
// nomi, soglie, alias) dovevamo rifare le richieste a Wikipedia. Con la
// carriera intera si può rifare qualunque verdetto offline, e il rattoppo
// non deve riscaricare nulla. Formato "una riga per giocatore" (JSONL):
// aggiungere costa sempre lo stesso anche con migliaia di giocatori, e se
// il processo viene interrotto si perde al massimo una riga. Se lo stesso
// id compare più volte (giocatore ricontrollato), vale l'ultima riga.
const CAREERS_FILE = "./wikipedia-careers.jsonl";
let appendChain = Promise.resolve();
function appendCareer(record) {
  const line = JSON.stringify(record) + "\n";
  appendChain = appendChain.then(() => fs.appendFile(CAREERS_FILE, line, "utf-8"));
  return appendChain;
}

async function loadCareers() {
  const careers = new Map();
  let text;
  try {
    text = await fs.readFile(CAREERS_FILE, "utf-8");
  } catch {
    return careers;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      careers.set(String(rec.id), rec); // l'ultima riga per id vince
    } catch {
      // riga troncata da un'interruzione brusca: la ignoriamo
    }
  }
  return careers;
}

// Giocatori che non riusciamo a risolvere (nessuna pagina trovata, o pagina
// trovata ma illeggibile): non finiscono in wikipedia-check.json (così
// vengono riprovati), ma li teniamo qui, salvati subito ad ogni caso e
// cumulativi tra un lancio e l'altro, con i dati utili per studiarli
// (anno di nascita, nazionalità, titolo trovato). Prima venivano scritti
// solo a fine lancio completo, quindi ogni Ctrl+C li faceva sparire.
const UNRESOLVED_FILE = "./wikipedia-unresolved.json";

async function loadUnresolvedFile() {
  try {
    const parsed = JSON.parse(await fs.readFile(UNRESOLVED_FILE, "utf-8"));
    return { unresolved: parsed.unresolved || {} };
  } catch {
    return { unresolved: {} };
  }
}

async function saveUnresolvedFile(data) {
  await writeJsonAtomic(UNRESOLVED_FILE, data);
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

  if (REVERDICT) {
    // Rifà i verdetti DA ZERO, senza rete, per tutti i giocatori di cui
    // abbiamo salvato la carriera completa di Wikipedia (wikipedia-careers
    // .jsonl): riapplica il confronto attuale (nomi club, alias, soglie)
    // alle tappe Wikipedia complete contro i nostri dati grezzi. A differenza
    // di "revalidate" (che rivede solo le tappe già segnate mancanti) qui si
    // riparte dalla carriera intera, quindi funziona con qualunque regola
    // nuova. I giocatori senza carriera salvata (controllati prima che
    // esistesse questo file) non vengono toccati.
    const rawForReverdict = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
    const byId = new Map((rawForReverdict.players || []).map((pl) => [String(pl.id), pl]));
    const careers = await loadCareers();
    await fs.copyFile(CHECK_FILE, CHECK_FILE.replace(/\.json$/, "") + ".backup.json").catch(() => {});

    let redone = 0, toOk = 0, toFail = 0, same = 0, notInRaw = 0;
    for (const [id, career] of careers) {
      const pl = byId.get(id);
      if (!pl) { notInRaw++; continue; }
      const v = computeVerdict(career.entries || [], pl.seasonRecords || []);
      if (!v) continue;
      const prev = checkData.checked[id];
      const newVerdict = v.fail ? "fail" : "ok";
      if (prev && prev.verdict === "fail" && newVerdict === "ok") toOk++;
      else if (prev && prev.verdict === "ok" && newVerdict === "fail") toFail++;
      else same++;
      checkData.checked[id] = {
        name: pl.name,
        wikipediaTitle: career.wikipediaTitle,
        verdict: newVerdict,
        missingFraction: Math.round(v.missingFraction * 100) / 100,
        missing: v.missing,
        checkedAt: prev?.checkedAt || career.fetchedAt
      };
      redone++;
    }
    await saveCheckFile(checkData);
    const all = Object.values(checkData.checked);
    console.log(`Carriere salvate: ${careers.size} | verdetti rifatti: ${redone}`);
    console.log(`  fail -> ok: ${toOk} | ok -> fail: ${toFail} | invariati: ${same}`);
    if (notInRaw) console.log(`  non presenti in raw-players.json (saltati): ${notInRaw}`);
    console.log(`Totali ora: ${all.filter((e) => e.verdict === "ok").length} ok, ${all.filter((e) => e.verdict === "fail").length} fail`);
    console.log(`Copia di sicurezza: ${CHECK_FILE.replace(/\.json$/, "")}.backup.json`);
    return;
  }

  if (REVALIDATE) {
    // Nessuna chiamata a Wikipedia: per ogni "fail" già salvato, riguardiamo
    // le tappe segnate come mancanti contro i dati grezzi, con il confronto
    // dei nomi club corretto (accenti, trattini, alias). Quelle che in realtà
    // erano coperte vengono tolte; se ne restano poche il verdetto passa a ok.
    // Prima di scrivere, copia di sicurezza del file dei verdetti.
    const rawForRevalidate = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
    const byId = new Map((rawForRevalidate.players || []).map((pl) => [String(pl.id), pl]));
    await fs.copyFile(CHECK_FILE, CHECK_FILE.replace(/\.json$/, "") + ".backup.json").catch(() => {});

    let examined = 0, flippedToOk = 0, reducedStillFail = 0, unchanged = 0, playerNotInRaw = 0;
    for (const [id, entry] of Object.entries(checkData.checked)) {
      if (entry.verdict !== "fail") continue;
      const pl = byId.get(String(id));
      if (!pl) { playerNotInRaw++; continue; }
      examined++;
      const oldMissing = entry.missing || [];
      if (oldMissing.length === 0) { unchanged++; continue; }
      // Il numero totale di tappe Wikipedia non è salvato: lo ricaviamo dalla
      // frazione (stessa strategia già usata da "recompute").
      const totalEntries = entry.missingFraction
        ? Math.round(oldMissing.length / entry.missingFraction)
        : oldMissing.length;
      const stillMissing = oldMissing.filter(
        (m) => !isCovered({ team: m.team, from: m.from, to: m.to }, pl.seasonRecords || [])
      );
      if (stillMissing.length === oldMissing.length) { unchanged++; continue; }
      const v = verdictFromMissing(stillMissing, Math.max(totalEntries, stillMissing.length, 1));
      entry.missing = stillMissing;
      entry.missingFraction = Math.round(v.missingFraction * 100) / 100;
      entry.verdict = v.fail ? "fail" : "ok";
      if (v.fail) reducedStillFail++; else flippedToOk++;
    }
    await saveCheckFile(checkData);
    const all = Object.values(checkData.checked);
    console.log(`"fail" esaminati: ${examined}`);
    console.log(`  passati a OK (tappe in realtà coperte): ${flippedToOk}`);
    console.log(`  restano fail ma con meno tappe mancanti: ${reducedStillFail}`);
    console.log(`  invariati: ${unchanged}`);
    if (playerNotInRaw) console.log(`  non presenti in raw-players.json (saltati): ${playerNotInRaw}`);
    console.log(`Totali ora: ${all.filter((e) => e.verdict === "ok").length} ok, ${all.filter((e) => e.verdict === "fail").length} fail`);
    console.log(`Copia di sicurezza: ${CHECK_FILE.replace(/\.json$/, "")}.backup.json`);

    // Club che risultano ancora "mancanti" più spesso: se un club COMUNE
    // (una big) è in cima a questa lista, quasi certamente è un alias non
    // ancora coperto (nome diverso tra fonte dati e Wikipedia), non un buco
    // vero. Da controllare a occhio e aggiungere a CLUB_ALIASES.
    const freq = new Map();
    for (const e of all) {
      if (e.verdict !== "fail") continue;
      for (const m of e.missing || []) freq.set(m.team, (freq.get(m.team) || 0) + 1);
    }
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    if (top.length > 0) {
      console.log("\nClub ancora \"mancanti\" più spesso tra i fail (possibili alias non coperti):");
      top.forEach(([team, n]) => console.log(`  ${String(n).padStart(4)}  ${team}`));
    }
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

  const unresolvedData = await loadUnresolvedFile();

  async function recordUnresolved(p, reason, titleFound) {
    unresolvedData.unresolved[p.id] = {
      name: p.name,
      birthYear: p.birthYear ?? null,
      nationality: p.nationality ?? null,
      reason, // "not_found" = nessuna pagina | "unreadable" = pagina trovata ma senza tappe leggibili
      titleFound: titleFound ?? null,
      lastTriedAt: new Date().toISOString()
    };
    await saveUnresolvedFile(unresolvedData);
  }

  // Ctrl+C: salva tutto quello che abbiamo prima di uscire, invece di
  // perdere gli ultimi verdetti non ancora scritti (il salvataggio
  // periodico avviene solo ogni N giocatori).
  let shuttingDown = false;
  process.on("SIGINT", async () => {
    if (shuttingDown) process.exit(1); // secondo Ctrl+C: esci subito
    shuttingDown = true;
    console.log("\nInterrotto: salvo i dati raccolti finora...");
    await saveCheckFile(checkData);
    await saveUnresolvedFile(unresolvedData);
    await appendChain;
    console.log("Salvato. Puoi riprendere con lo stesso comando.");
    process.exit(0);
  });

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
      let title, wikitext;
      const combined = await searchAndFetchWikitext(p.name);
      await sleep(REQUEST_DELAY_MS);
      if (combined.title && combined.wikitext) {
        title = combined.title;
        wikitext = combined.wikitext;
      } else {
        // Il tentativo combinato non ha trovato nulla (raro): torniamo al
        // percorso separato, che include anche la ricerca a testo pieno e
        // le combinazioni di nome come riserva.
        title = await findWikipediaTitle(p.name, p.birthYear);
        await sleep(REQUEST_DELAY_MS);
        if (!title) {
          console.log(`? ${p.name}: nessuna pagina Wikipedia trovata, salto (non salvato: riprovabile in futuro)`);
          notFoundOnWikipedia++;
          await recordUnresolved(p, "not_found", null);
          printProgress();
          continue;
        }
        wikitext = await fetchWikitext(title);
        await sleep(REQUEST_DELAY_MS);
      }
      let wikiEntries = parseSeniorCareer(wikitext);

      // Anche se ha trovato delle tappe, controlliamo che la pagina sia
      // DAVVERO quella giusta (nome imparentato + anno di nascita, se
      // disponibile) - bug reale: "José" da solo si agganciava sempre a
      // "Josue (footballer, born 1987)", un'altra persona con 10 tappe
      // proprie, accettata per errore solo perché il numero era alto.
      if (wikiEntries.length > 0 && !isTrustworthyMatch(p.name, title, wikitext, p.birthYear, true, p.name)) {
        const foundFullName = extractFullNameField(wikitext);
        const foundBirthYear = extractBirthYear(wikitext);
        console.log(`  (${p.name}: pagina trovata (${title}) non sembra la persona giusta, la scarto e riprovo...)`);
        console.log(`    [diagnostica] campo fullname letto: ${JSON.stringify(foundFullName)} | anno letto: ${foundBirthYear} | nostro anno: ${p.birthYear}`);
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
        if (wikiEntries.length > 0 && !isTrustworthyMatch(p.name, title, wikitext, p.birthYear, true, p.name)) {
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

        // Proviamo prima la ricerca a testo pieno col nome completo: trova
        // pagine dove il nome vero compare nell'infobox anche se il titolo
        // è un soprannome/forma abbreviata diversa - bug reale trovato:
        // "Yannick Anister Sagbo-Latte" nei nostri dati, ma la pagina si
        // chiama solo "Yannick Sagbo" (il "-Latte" del cognome scartato) -
        // nessuna combinazione di parole avrebbe mai prodotto questo senza
        // sapere in anticipo di dover spezzare il trattino.
        console.log(`  (${p.name}: provo la ricerca a testo pieno...)`);
        const fullTextTitles = await fullTextSearchTitles(p.name);
        await sleep(REQUEST_DELAY_MS);
        // Niente filtro sul nome qui: il punto della ricerca a testo pieno
        // è proprio trovare pagine il cui TITOLO non assomiglia al nome
        // cercato (soprannomi come "Pepe" per "José") - il nome compare
        // comunque nel contenuto della pagina, quindi ci affidiamo
        // all'anno di nascita come conferma, se lo conosciamo. Senza anno
        // di nascita noto, torniamo a richiedere la somiglianza del nome
        // per sicurezza (nessun altro segnale a cui appoggiarsi).
        const requireNameForFullText = !p.birthYear;
        for (const candidateTitle of fullTextTitles) {
          if (candidateTitle === title) continue;
          const candidateWikitext = await fetchWikitext(candidateTitle);
          await sleep(REQUEST_DELAY_MS);
          const candidateEntries = parseSeniorCareer(candidateWikitext);
          const trustworthy = candidateEntries.length > 0 && isTrustworthyMatch(p.name, candidateTitle, candidateWikitext, p.birthYear, requireNameForFullText, p.name);
          if (trustworthy && candidateEntries.length > bestEntries.length) {
            bestEntries = candidateEntries;
            bestTitle = candidateTitle;
            wikitext = candidateWikitext;
          }
          if (bestEntries.length >= MIN_ACCEPTABLE) break;
        }

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
            const trustworthy = candidateEntries.length > 0 && isTrustworthyMatch(shortName, shortTitle, candidateWikitext, p.birthYear, true, p.name);
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
        await recordUnresolved(p, "unreadable", title);
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

      // Carriera completa di Wikipedia, con i dati per poter rifare il
      // controllo in futuro senza rete (titolo, nome completo e anno di
      // nascita letti dalla pagina, per validare che sia la persona giusta).
      await appendCareer({
        id: p.id,
        name: p.name,
        birthYear: p.birthYear ?? null,
        wikipediaTitle: title,
        pageBirthYear: extractBirthYear(wikitext),
        pageFullName: extractFullNameField(wikitext),
        entries: wikiEntries,
        fetchedAt: new Date().toISOString()
      });

      // Se era tra i non risolti di un lancio precedente e ora ha un
      // verdetto, non è più un caso aperto.
      if (unresolvedData.unresolved[p.id]) {
        delete unresolvedData.unresolved[p.id];
        await saveUnresolvedFile(unresolvedData);
      }

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

  await saveUnresolvedFile(unresolvedData);
  const openCases = Object.values(unresolvedData.unresolved);
  console.log(`Casi non risolti (cumulativi, tra tutti i lanci): ${openCases.length}`);
  console.log(`  - nessuna pagina trovata: ${openCases.filter((c) => c.reason === "not_found").length}`);
  console.log(`  - pagina trovata ma illeggibile: ${openCases.filter((c) => c.reason === "unreadable").length}`);
  console.log(`Dettagli (nome, anno di nascita, nazionalità) in: ${UNRESOLVED_FILE}`);

  if (!FULL_SCAN) {
    console.log("Rilancia con lo stesso comando per controllarne altri (salta chi è già fatto).");
  }
}

main();
