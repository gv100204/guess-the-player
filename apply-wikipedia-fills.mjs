// ---------------------------------------------------------------------------
// apply-wikipedia-fills.mjs
//
// Legge wikipedia-check.json (prodotto da verify-against-wikipedia.mjs) e
// inserisce in raw-players.json le tappe mancanti trovate su Wikipedia,
// come BLOCCHI storici già aggregati (un'unica riga per l'intera tappa,
// non spalmata stagione per stagione - è il formato che Wikipedia dà
// nativamente, ed è anche quello che il gioco mostra già di suo).
//
// AUTOMATICO: nessuna conferma richiesta per ogni singolo inserimento (come
// deciso insieme). Restano comunque alcuni controlli di sicurezza
// automatici per non scrivere dati chiaramente rotti - non sono conferme
// manuali, sono solo controlli di buon senso:
//   - salta tappe senza un numero di presenze valido
//   - salta tappe con un intervallo di anni assurdo (arrivo dopo la
//     partenza, o più di 30 anni di distanza - quasi certamente un errore
//     di lettura del wikitext, non un dato vero)
//   - salta tappe già inserite in un lancio precedente (stesso club+anni),
//     per non duplicarle se rilanci lo script
//
// NON tocca mai raw-players.json direttamente: scrive
// raw-players.filled.json accanto all'originale, che poi rinomini tu
// stesso - stessa abitudine di clean-raw-data.mjs.
//
// Uso:
//   node apply-wikipedia-fills.mjs [raw-players.json] [wikipedia-check.json]
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import path from "node:path";

const RAW_FILE = process.argv[2] || "./raw-players.json";
const CHECK_FILE = process.argv[3] || "./wikipedia-check.json";
const MAX_PLAUSIBLE_SPAN_YEARS = 30;

// Stessa normalizzazione di verify-against-wikipedia.mjs: senza questa,
// lo stesso club scritto in due modi ("Atletico"/"Athletico Paranaense",
// "El"/"Al-Mokawloon"...) sembra un club diverso, e il controllo qui sotto
// crederebbe per errore che il giocatore sia in due squadre insieme.
const CLUB_ALIASES = new Map([
  ["qpr", "queens park rangers"],
  ["bayern munchen", "bayern munich"],
  ["wolves", "wolverhampton wanderers"],
  ["olympiakos piraeus", "olympiacos"],
  ["athletic club", "athletic bilbao"],
  ["vitoria sc", "vitoria guimaraes"],
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
  ["athletic club ii", "bilbao athletic"],
  ["celta de vigo ii", "celta ii"],
  ["pacos ferreira", "pacos de ferreira"],
  ["bayern munchen ii", "bayern munich ii"],
  ["olympique lyonnais ii", "lyon b"],
  ["gazelec fc ajaccio", "gazelec ajaccio"],
  ["st truiden", "sint truiden"],
  ["atletico paranaense", "athletico paranaense"],
  ["psg ii", "paris saint germain b"],
  ["borussia mgladbach ii", "borussia monchengladbach ii"],
  ["sevilla atletico", "sevilla b"],
  ["vitoria de guimaraes", "vitoria guimaraes"],
  ["slavia praha", "slavia prague"],
  ["austria vienna", "austria wien"],
  ["rapid vienna", "rapid wien"],
  ["u madeira", "uniao madeira"],
  ["el mokawloon", "al mokawloon"],
  ["universidad catolica", "u catolica"],
  ["club libertad", "libertad asuncion"]
]);
const LETTER_FIXES = { "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss" };
function normClub(s) {
  let base = (s || "")
    .toLowerCase()
    .replace(/[øæœłđðþß]/g, (c) => LETTER_FIXES[c])
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  base = base.replace(/ b$/, " ii");
  return CLUB_ALIASES.get(base) || base;
}

// Un giocatore non può essere in due squadre diverse nello stesso anno.
// Prima di scrivere un blocco storico, controlliamo se negli stessi anni
// c'è già una tappa (di qualunque fonte) per un club DIVERSO, e tagliamo
// il blocco per non sovrapporsi - preferendo accorciare il blocco nuovo
// (la riga di riepilogo di Wikipedia, più larga e meno precisa) piuttosto
// che toccare una tappa già esistente (più spesso stagione-per-stagione,
// quindi più precisa). Se dopo il taglio non resta nulla di sensato,
// scartiamo il blocco: meglio un buco che un dato inventato.
function clipAgainstExisting(entry, seasonRecords) {
  let { from, to } = entry;
  for (const r of seasonRecords || []) {
    if (!r.club) continue;
    if (normClub(r.club) === normClub(entry.team)) continue; // stesso club, nessun conflitto
    const rFrom = r.season;
    const rTo = r.blockToYear ?? r.season;
    const overlaps = from < rTo && rFrom < to; // rigoroso: toccarsi sul confine non conta
    if (!overlaps) continue;
    if (rFrom <= from && rTo >= to) return null; // il conflitto copre TUTTO il blocco: scartiamo
    if (rFrom <= from) from = rTo; // il conflitto copre l'inizio: tagliamo l'inizio
    else if (rTo >= to) to = rFrom; // il conflitto copre la fine: tagliamo la fine
    else to = rFrom; // il conflitto è nel mezzo: tagliamo la coda (stessa semplificazione usata per i prestiti)
  }
  // <= e non <: una tappa di UN SOLO anno (es. 2005-2005) è valida. Bug reale:
  // con < venivano scartate tutte, come se fossero "coperte del tutto" da un
  // altro club anche senza nessun conflitto.
  return from <= to ? { from, to } : null;
}

function isPlausible(entry) {
  // Le presenze mancanti o sconosciute NON scartano più la tappa - va
  // aggiunta comunque, con apps null (sconosciuto, da mostrare come
  // "presenze non disponibili"), non zero. La sequenza completa della
  // carriera vale più del numero esatto di presenze per una tappa minore
  // di cui Wikipedia non riporta le statistiche (tipico per club piccoli
  // o esteri poco documentati).
  if (entry.to < entry.from) return false;
  if (entry.to - entry.from > MAX_PLAUSIBLE_SPAN_YEARS) return false;
  if (!entry.team || entry.team.trim().length < 2) return false;
  return true;
}

function alreadyHasBlock(seasonRecords, entry) {
  // Un blocco dello stesso club che si sovrappone alla tappa di Wikipedia (o
  // coincide) conta come già presente. Prima il confronto era sugli anni
  // ESATTI, ma un blocco tagliato per non sovrapporsi a un altro club ha
  // anni diversi da quelli di Wikipedia: rilanciando lo script veniva
  // riaggiunto un secondo blocco identico, e i due, fondendosi in uscita,
  // sommavano le presenze.
  const club = normClub(entry.team);
  return (seasonRecords || []).some((r) => {
    if (r.blockToYear == null || normClub(r.club) !== club) return false;
    if (r.season === entry.from && r.blockToYear === entry.to) return true;
    const overlap = Math.min(r.blockToYear, entry.to) - Math.max(r.season, entry.from);
    return overlap > 0;
  });
}

async function main() {
  const raw = JSON.parse(await fs.readFile(RAW_FILE, "utf-8"));
  const checkData = JSON.parse(await fs.readFile(CHECK_FILE, "utf-8"));
  const players = raw.players || [];
  const byId = new Map(players.map((p) => [String(p.id), p]));

  let playersAffected = 0;
  let blocksAdded = 0;
  let skippedImplausible = 0;
  let skippedDuplicate = 0;
  let skippedOverlap = 0;
  let clippedForOverlap = 0;
  let verdictsUpgraded = 0;

  for (const [id, entry] of Object.entries(checkData.checked || {})) {
    const p = byId.get(id);
    if (!p) continue;
    const missing = entry.missing || [];
    let touchedThisPlayer = false;
    let allMissingResolved = true; // resta true solo se OGNI tappa mancante è stata aggiunta o era già presente

    for (const m of missing) {
      if (!isPlausible(m)) {
        skippedImplausible++;
        allMissingResolved = false; // questa non l'abbiamo risolta: il giocatore ha ancora un buco vero
        continue;
      }
      if (alreadyHasBlock(p.seasonRecords, m)) {
        skippedDuplicate++;
        continue; // già risolta in un lancio precedente, va bene comunque
      }
      // Un giocatore non può essere in due squadre nello stesso anno: se il
      // blocco si sovrappone a una tappa già esistente di un altro club, lo
      // tagliamo (o lo scartiamo, se il conflitto lo copre del tutto).
      const clipped = clipAgainstExisting(m, p.seasonRecords);
      if (!clipped) {
        skippedOverlap++;
        allMissingResolved = false; // il conflitto copriva tutto il blocco: resta un buco vero
        continue;
      }
      if (clipped.from !== m.from || clipped.to !== m.to) clippedForOverlap++;
      p.seasonRecords = p.seasonRecords || [];
      p.seasonRecords.push({
        season: clipped.from,
        blockToYear: clipped.to,
        club: m.team,
        league: null,
        leagueRaw: "Storico",
        country: null,
        apps: m.apps,
        goals: m.apps == null ? null : (m.goals || 0),
        source: "wikipedia"
      });
      blocksAdded++;
      touchedThisPlayer = true;
    }
    if (touchedThisPlayer) playersAffected++;

    // Se TUTTE le tappe mancanti sono state risolte (aggiunte ora o già
    // presenti da prima), il giocatore non ha più motivo di restare
    // escluso dal gioco - bug reale trovato: senza questo aggiornamento,
    // un giocatore riparato restava comunque fuori, perché il verdetto
    // "fail" non veniva mai ricalcolato dopo la riparazione.
    if (entry.verdict === "fail" && missing.length > 0 && allMissingResolved) {
      entry.verdict = "ok";
      entry.filledFromWikipediaAt = new Date().toISOString();
      verdictsUpgraded++;
    }
  }

  console.log(`Giocatori toccati: ${playersAffected}`);
  console.log(`Blocchi storici aggiunti: ${blocksAdded}`);
  console.log(`Verdetti passati da FALLISCE a OK (ora riparati del tutto): ${verdictsUpgraded}`);
  console.log(`Scartati per dati implausibili (0 presenze, intervallo assurdo, nome troppo corto): ${skippedImplausible}`);
  console.log(`Scartati perché già presenti da un lancio precedente: ${skippedDuplicate}`);
  console.log(`Scartati perché coperti del tutto da una tappa di un altro club: ${skippedOverlap}`);
  console.log(`Tagliati per non sovrapporsi a una tappa di un altro club: ${clippedForOverlap}`);

  const dir = path.dirname(RAW_FILE);
  const outPath = path.join(dir, "raw-players.filled.json");
  await fs.writeFile(outPath, JSON.stringify(raw, null, 2), "utf-8");
  console.log(`\nScritto: ${outPath}`);
  console.log("L'originale NON è stato toccato. Controlla il nuovo file, poi se va bene");
  console.log("rinominalo/sostituiscilo tu stesso a raw-players.json prima del prossimo sync.");

  // wikipedia-check.json invece lo aggiorniamo DIRETTAMENTE: è già lui il
  // checkpoint della scansione, e i verdetti passati da FALLISCE a OK
  // devono valere subito per il prossimo sync, senza un passaggio manuale
  // in più come per raw-players.json.
  await fs.writeFile(CHECK_FILE, JSON.stringify(checkData, null, 2), "utf-8");
  console.log(`Aggiornato: ${CHECK_FILE} (verdetti riparati salvati)`);
}

main();
