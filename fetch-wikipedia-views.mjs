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
