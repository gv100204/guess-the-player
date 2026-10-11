// Scarica le visite mensili delle pagine Wikipedia dei giocatori (API
// pubblica Wikimedia, nessuna chiave) e salva la media degli ultimi 12 mesi
// in wikipedia-views.json. Serve come misura di FAMA per i livelli di
// difficoltà del gioco: più visite = più famoso = più facile da indovinare.
//
// Legge i titoli da wikipedia-careers.jsonl (id + wikipediaTitle, scritto da
// verify-against-wikipedia.mjs). Riprende da dove era rimasto: chi è già in
// wikipedia-views.json viene saltato (salvo --refresh). Si può fermare con
// Ctrl+C in qualunque momento.
//
// Uso:
//   node fetch-wikipedia-views.mjs --test 20   -> prova su 20 giocatori, stampa e NON salva
//   node fetch-wikipedia-views.mjs             -> scarica per tutti quelli mancanti
//   node fetch-wikipedia-views.mjs --refresh   -> rifà anche quelli già scaricati
//   node fetch-wikipedia-views.mjs --fix-redirects [1000] -> per chi ha poche visite, segue i reindirizzamenti e riconta
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAREERS_FILE = "./wikipedia-careers.jsonl";
const VIEWS_FILE = "./wikipedia-views.json";
const PAUSE_MS = 250;           // gentili con Wikimedia: ~4 richieste al secondo
const SAVE_EVERY = 25;
const MAX_RETRIES = 6;
// Wikimedia chiede un User-Agent che identifichi chi chiama.
const USER_AGENT = "guess-the-player-fame/1.0 (https://github.com/gv100204/guess-the-player)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Intervallo degli ultimi 12 mesi COMPLETI, nel formato YYYYMMDDHH dell'API. */
export function last12MonthsRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11, mese corrente (incompleto)
  const startDate = new Date(Date.UTC(y, m - 12, 1));
  const endDate = new Date(Date.UTC(y, m, 0)); // ultimo giorno del mese scorso
  const fmt = (d) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}00`;
  return { start: fmt(startDate), end: fmt(endDate) };
}

/** Il titolo nell'URL: spazi -> underscore, poi codifica. */
export function encodeArticleTitle(title) {
  return encodeURIComponent(title.trim().replace(/ /g, "_"));
}

/**
 * Visite medie mensili di una pagina. Ritorna:
 *   { avgMonthlyViews, months }   se ci sono dati
 *   { avgMonthlyViews: null }     se la pagina non risulta (404) - non vale come "zero visite"
 *   null                          se l'errore è temporaneo e va riprovato più tardi
 */
export async function fetchAvgMonthlyViews(title, now = new Date()) {
  const { start, end } = last12MonthsRange(now);
  const url =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/" +
    `${encodeArticleTitle(title)}/monthly/${start}/${end}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    } catch (err) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return { avgMonthlyViews: null };
    if (res.status === 429 || res.status >= 500) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (!res.ok) return null;
    const json = await res.json();
    const items = Array.isArray(json?.items) ? json.items : [];
    if (items.length === 0) return { avgMonthlyViews: null };
    const total = items.reduce((s, it) => s + (Number(it.views) || 0), 0);
    // Media su 12 mesi pieni (un mese senza dato conta come zero: una
    // pagina creata da poco ha meno visite totali di una vecchia).
    return { avgMonthlyViews: Math.round(total / 12), months: items.length };
  }
  return null;
}

/**
 * Segue i reindirizzamenti di Wikipedia: "Steven N'Kemboanza Mike Christ Nzonzi"
 * porta a "Steven Nzonzi". Le visite si contano sulla pagina VERA: sul
 * reindirizzamento ce ne sono pochissime e il giocatore sembrerebbe ignoto.
 * Ritorna il titolo finale (o quello di partenza se non c'è reindirizzamento,
 * o null in caso di errore temporaneo).
 */
export async function resolveRedirect(title) {
  const url = "https://en.wikipedia.org/w/api.php?action=query&redirects=1&format=json&formatversion=2&titles=" + encodeURIComponent(title);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) return null;
      const json = await res.json();
      const redirects = json?.query?.redirects;
      if (Array.isArray(redirects) && redirects.length > 0) return redirects[redirects.length - 1].to || title;
      return title;
    } catch {
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

async function loadTitles() {
  let text = "";
  try { text = await fs.readFile(CAREERS_FILE, "utf-8"); } catch {
    console.error(`Non trovo ${CAREERS_FILE}: serve prima aver lanciato verify-against-wikipedia.mjs.`);
    process.exit(1);
  }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.id != null && rec.wikipediaTitle) byId.set(String(rec.id), rec.wikipediaTitle);
    } catch { /* riga troncata: ignorata */ }
  }
  return byId;
}

async function loadViews() {
  try { return JSON.parse(await fs.readFile(VIEWS_FILE, "utf-8")); }
  catch { return { version: new Date().toISOString(), views: {} }; }
}

async function saveViews(data) {
  data.version = new Date().toISOString();
  const tmp = VIEWS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
  await fs.rename(tmp, VIEWS_FILE);
}

async function main() {
  const args = process.argv.slice(2);
  const testIdx = args.indexOf("--test");
  const testN = testIdx >= 0 ? Number(args[testIdx + 1]) || 20 : 0;
  const refresh = args.includes("--refresh");

  const titles = await loadTitles();
  const data = await loadViews();

  // --fix-redirects [soglia]: per chi ha poche visite (default < 1000/mese)
  // controlla se il titolo salvato è un reindirizzamento e, se sì, rifà il
  // conteggio sulla pagina vera. Mette a posto i casi tipo "nome legale lungo
  // = 1 visita al mese".
  const fixIdx = args.indexOf("--fix-redirects");
  if (fixIdx >= 0) {
    const threshold = Number(args[fixIdx + 1]) || 1000;
    const low = Object.entries(data.views).filter(([, v]) => v.avgMonthlyViews != null && v.avgMonthlyViews < threshold);
    console.log(`Controllo i reindirizzamenti per ${low.length} giocatori con meno di ${threshold} visite/mese...`);
    let stop = false, changed = 0, checked = 0;
    process.on("SIGINT", () => { stop = true; console.log("\nInterruzione richiesta, salvo e esco..."); });
    for (const [id, v] of low) {
      if (stop) break;
      const target = await resolveRedirect(v.title);
      await sleep(PAUSE_MS);
      checked++;
      if (target && target !== v.title) {
        const result = await fetchAvgMonthlyViews(target);
        await sleep(PAUSE_MS);
        if (result && result.avgMonthlyViews != null) {
          console.log(`  ${v.title} -> ${target}: ${v.avgMonthlyViews} -> ${result.avgMonthlyViews} visite/mese`);
          data.views[id] = { title: target, avgMonthlyViews: result.avgMonthlyViews, fetchedAt: new Date().toISOString(), redirectedFrom: v.title };
          changed++;
        }
      }
      if (checked % 25 === 0) { await saveViews(data); console.log(`  [${checked}/${low.length}] salvato (corretti: ${changed})`); }
    }
    await saveViews(data);
    console.log(`\nFatto: controllati ${checked} | corretti ${changed}`);
    return;
  }

  let todo = [...titles.entries()].filter(([id]) => refresh || !data.views[id]);
  if (testN) todo = todo.slice(0, testN);

  console.log(`Titoli Wikipedia noti: ${titles.size} | già scaricati: ${Object.keys(data.views).length} | da fare ora: ${todo.length}`);
  if (testN) console.log(`MODO PROVA: ${testN} giocatori, i risultati NON vengono salvati.\n`);

  let stopRequested = false;
  process.on("SIGINT", () => { stopRequested = true; console.log("\nInterruzione richiesta, salvo e esco..."); });

  let done = 0, notFound = 0, failed = 0;
  for (const [id, title] of todo) {
    if (stopRequested) break;
    const result = await fetchAvgMonthlyViews(title);
    if (result === null) {
      failed++; // errore temporaneo: non lo salviamo, verrà riprovato al prossimo lancio
    } else {
      if (result.avgMonthlyViews === null) notFound++;
      if (testN) console.log(`  ${title}: ${result.avgMonthlyViews === null ? "pagina non trovata" : result.avgMonthlyViews + " visite/mese"}`);
      else data.views[id] = { title, avgMonthlyViews: result.avgMonthlyViews, fetchedAt: new Date().toISOString() };
    }
    done++;
    if (!testN && done % SAVE_EVERY === 0) {
      await saveViews(data);
      console.log(`  [${done}/${todo.length}] salvato (non trovati: ${notFound}, da riprovare: ${failed})`);
    }
    await sleep(PAUSE_MS);
  }

  if (!testN) await saveViews(data);

  console.log(`\nFatto: ${done} elaborati | pagina non trovata: ${notFound} | da riprovare: ${failed}`);
  if (!testN) {
    const withViews = Object.values(data.views).filter((v) => v.avgMonthlyViews != null)
      .sort((a, b) => b.avgMonthlyViews - a.avgMonthlyViews);
    console.log(`Giocatori con visite note: ${withViews.length}`);
    if (withViews.length >= 10) {
      console.log("\nI 5 più visti:");
      withViews.slice(0, 5).forEach((v) => console.log(`  ${v.title}: ${v.avgMonthlyViews}/mese`));
      console.log("I 5 meno visti:");
      withViews.slice(-5).forEach((v) => console.log(`  ${v.title}: ${v.avgMonthlyViews}/mese`));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
