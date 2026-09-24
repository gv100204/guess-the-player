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

function isPlausible(entry) {
  if (!entry.apps || entry.apps <= 0) return false;
  if (entry.to < entry.from) return false;
  if (entry.to - entry.from > MAX_PLAUSIBLE_SPAN_YEARS) return false;
  if (!entry.team || entry.team.trim().length < 2) return false;
  return true;
}

function alreadyHasBlock(seasonRecords, entry) {
  return (seasonRecords || []).some(
    (r) => r.blockToYear != null && r.club === entry.team && r.season === entry.from && r.blockToYear === entry.to
  );
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
      p.seasonRecords = p.seasonRecords || [];
      p.seasonRecords.push({
        season: m.from,
        blockToYear: m.to,
        club: m.team,
        league: null,
        leagueRaw: "Storico",
        country: null,
        apps: m.apps,
        goals: m.goals || 0,
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
