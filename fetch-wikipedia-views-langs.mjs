// Visite mensili delle pagine Wikipedia dei giocatori NELLE ALTRE LINGUE
// (italiano, francese, tedesco, spagnolo, portoghese), non solo in inglese.
// Serve a calcolare la fama "locale": un giocatore della Bundesliga è molto
// più noto per un tedesco di quanto dicano le visite a Wikipedia in inglese.
//
// Come funziona:
//   1. legge i giocatori del gioco (output/players-data.json) e il titolo della
//      loro pagina inglese (wikipedia-views.json, che ha già i reindirizzamenti
//      risolti, oppure wikipedia-careers.jsonl);
//   2. chiede a Wikidata il titolo della stessa pagina nelle altre lingue
//      (50 giocatori per richiesta);
//   3. per ogni lingua conta le visite medie mensili degli ultimi 12 mesi.
// Salva in wikipedia-views-langs.json:
//   views[id][lingua] = { title, avgMonthlyViews }   pagina trovata
//   views[id][lingua] = { title: null }              nessuna pagina in quella lingua
// Riprende da dove era rimasto, si può fermare con Ctrl+C.
//
// Uso:
//   node fetch-wikipedia-views-langs.mjs --test 10     prova su 10 giocatori, NON salva
//   node fetch-wikipedia-views-langs.mjs               tutti i giocatori, tutte le lingue
//   node fetch-wikipedia-views-langs.mjs --langs de,fr solo alcune lingue
//   node fetch-wikipedia-views-langs.mjs --report      riepilogo di quello che c'è già
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { last12MonthsRange, encodeArticleTitle } from "./fetch-wikipedia-views.mjs";

const OUT_FILE = "./wikipedia-views-langs.json";
const VIEWS_EN_FILE = "./wikipedia-views.json";
const CAREERS_FILE = "./wikipedia-careers.jsonl";
const GAME_FILES = ["./output/players-data.json", "./players-data.json"];
const ALL_LANGS = ["it", "fr", "de", "es", "pt"];
const CONCURRENCY = 3;
const PAUSE_MS = 150;
const SAVE_EVERY = 100;
const MAX_RETRIES = 6;
const USER_AGENT = "guess-the-player-fame/1.0 (https://github.com/gv100204/guess-the-player)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
    } catch { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 404) return { notFound: true };
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) return null;
    try { return await res.json(); } catch { return null; }
  }
  return null;
}

/** Visite medie mensili di una pagina in una data lingua. null = errore temporaneo. */
export async function fetchViewsInLang(lang, title, now = new Date()) {
  const { start, end } = last12MonthsRange(now);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${encodeArticleTitle(title)}/monthly/${start}/${end}`;
  const j = await getJson(url);
  if (j === null) return null;
  if (j.notFound) return { avgMonthlyViews: null };
  const items = Array.isArray(j.items) ? j.items : [];
  if (items.length === 0) return { avgMonthlyViews: null };
  const total = items.reduce((s, it) => s + (Number(it.views) || 0), 0);
  return { avgMonthlyViews: Math.round(total / 12) };
}

/**
 * Titoli nelle altre lingue per un gruppo di pagine inglesi (max 50), via
 * Wikidata. Ritorna Map(titoloInglese -> { it: "titolo", fr: ..., ... }), o
 * null se la richiesta è fallita in modo temporaneo.
 */
export async function fetchSitelinks(enTitles, langs) {
  const sites = ["enwiki", ...langs.map((l) => l + "wiki")];
  const url = "https://www.wikidata.org/w/api.php?" + new URLSearchParams({
    action: "wbgetentities", format: "json", formatversion: "2",
    sites: "enwiki", titles: enTitles.join("|"), props: "sitelinks", sitefilter: sites.join("|")
  });
  const j = await getJson(url);
  if (!j || !j.entities) return null;
  const out = new Map();
  for (const ent of Object.values(j.entities)) {
    const sl = ent.sitelinks;
    if (!sl || !sl.enwiki) continue;
    const links = {};
    for (const l of langs) if (sl[l + "wiki"]) links[l] = sl[l + "wiki"].title;
    out.set(sl.enwiki.title, links);
  }
  return out;
}

async function readJsonSafe(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf-8")); } catch { return fallback; }
}

function idsFrom(d) {
  const ids = new Set();
  for (const p of d.players) {
    const m = String(p.id).match(/-(\d+)$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Il file del gioco si trova in locale solo se hai ricostruito qui; di solito
// non c'è (la cartella output/ la crea la ricostruzione su GitHub e non viene
// salvata nel repository), quindi lo scarichiamo dal gioco pubblicato.
const PUBLISHED_URL = "https://gv100204.github.io/guess-the-player/players-data.json";

async function loadGameIds() {
  for (const f of GAME_FILES) {
    const d = await readJsonSafe(f, null);
    if (d && Array.isArray(d.players)) return { ids: idsFrom(d), file: f };
  }
  try {
    const res = await fetch(PUBLISHED_URL, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const d = await res.json();
      if (d && Array.isArray(d.players)) return { ids: idsFrom(d), file: PUBLISHED_URL };
    }
  } catch { /* nessuna rete o gioco non raggiungibile */ }
  return null;
}

async function loadEnTitles() {
  const byId = new Map();
  const careers = await fs.readFile(CAREERS_FILE, "utf-8").catch(() => "");
  for (const line of careers.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.id != null && r.wikipediaTitle) byId.set(String(r.id), r.wikipediaTitle); } catch {}
  }
  // i titoli di wikipedia-views.json hanno già i reindirizzamenti risolti: hanno la precedenza
  const ve = await readJsonSafe(VIEWS_EN_FILE, { views: {} });
  for (const [id, v] of Object.entries(ve.views || {})) if (v && v.title) byId.set(String(id), v.title);
  return byId;
}

async function save(data) {
  data.version = new Date().toISOString();
  const tmp = OUT_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
  await fs.rename(tmp, OUT_FILE);
}

function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function report() {
  const data = await readJsonSafe(OUT_FILE, null);
  if (!data) { console.log("Nessun dato ancora: lancia prima node fetch-wikipedia-views-langs.mjs"); return; }
  const ids = Object.keys(data.views);
  console.log(`Giocatori con dati: ${ids.length}`);
  for (const l of ALL_LANGS) {
    const withPage = ids.map((id) => data.views[id][l]).filter((x) => x && x.title && x.avgMonthlyViews != null);
    const noPage = ids.filter((id) => data.views[id][l] && data.views[id][l].title === null).length;
    console.log(`  ${l}: pagina trovata ${withPage.length} | senza pagina ${noPage} | mediana visite ${median(withPage.map((x) => x.avgMonthlyViews))}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--report")) return report();
  const testIdx = args.indexOf("--test");
  const testN = testIdx >= 0 ? Number(args[testIdx + 1]) || 10 : 0;
  const langIdx = args.indexOf("--langs");
  const langs = langIdx >= 0 ? args[langIdx + 1].split(",").map((s) => s.trim()).filter((l) => ALL_LANGS.includes(l)) : ALL_LANGS;
  if (langs.length === 0) { console.error("Lingue valide: " + ALL_LANGS.join(", ")); process.exit(1); }

  const game = await loadGameIds();
  if (!game) { console.error("Non riesco a leggere l'elenco dei giocatori del gioco (né in locale né da " + PUBLISHED_URL + "). Controlla la connessione e che il gioco sia pubblicato."); process.exit(1); }
  const enTitles = await loadEnTitles();
  const data = await readJsonSafe(OUT_FILE, { version: null, views: {} });

  let todo = [...game.ids].filter((id) => enTitles.has(id)).filter((id) => {
    const cur = data.views[id];
    return !cur || langs.some((l) => cur[l] === undefined);
  });
  if (testN) todo = todo.slice(0, testN);
  console.log(`Giocatori del gioco: ${game.ids.size} (da ${game.file}) | con titolo Wikipedia: ${[...game.ids].filter((i) => enTitles.has(i)).length} | da fare ora: ${todo.length} | lingue: ${langs.join(", ")}`);
  if (testN) console.log(`MODO PROVA: ${testN} giocatori, i risultati NON vengono salvati.\n`);

  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log("\nInterruzione richiesta, salvo e esco..."); });

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length && !stop; i += 50) {
    const chunk = todo.slice(i, i + 50);
    const titles = chunk.map((id) => enTitles.get(id));
    const links = await fetchSitelinks(titles, langs);
    await sleep(PAUSE_MS);
    if (links === null) { failed += chunk.length; continue; }

    const jobs = [];
    for (const id of chunk) {
      const en = enTitles.get(id);
      const found = links.get(en) || links.get(en.replace(/_/g, " ")) || {};
      data.views[id] = data.views[id] || {};
      for (const l of langs) {
        if (data.views[id][l] !== undefined) continue;
        if (!found[l]) { data.views[id][l] = { title: null }; continue; }
        jobs.push({ id, l, title: found[l] });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length && !stop) {
        const job = jobs[next++];
        const r = await fetchViewsInLang(job.l, job.title);
        if (r === null) { failed++; continue; } // errore temporaneo: al prossimo lancio
        data.views[job.id][job.l] = { title: job.title, avgMonthlyViews: r.avgMonthlyViews };
        await sleep(PAUSE_MS);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    done += chunk.length;
    if (testN) {
      for (const id of chunk) {
        const parts = langs.map((l) => { const e = data.views[id][l]; return `${l}=${!e ? "?" : e.title === null ? "-" : e.avgMonthlyViews}`; });
        console.log(`  ${enTitles.get(id)}: ${parts.join(" ")}`);
      }
    } else if (done % SAVE_EVERY === 0 || done === todo.length) {
      await save(data);
      console.log(`  [${done}/${todo.length}] salvato (da riprovare: ${failed})`);
    }
  }
  if (!testN) await save(data);
  console.log(`\nFatto: ${done} giocatori elaborati | da riprovare: ${failed}`);
  if (!testN) await report();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
