// Controlli di qualità sui dati del gioco appena costruiti (output/players-data.json).
// Serve a NON pubblicare un gioco rotto: se un controllo fallisce, il workflow
// si ferma prima della pubblicazione e resta online la versione precedente.
//
// Tre gruppi di controlli:
//   1. Casi noti (giocatori che in passato hanno avuto un difetto: se tornano
//      sbagliati, il controllo scatta). Si aggiungono qui sotto in CASI_NOTI.
//   2. Regole sempre valide (nessuna parentesi vuota nei nomi dei club, formato
//      degli anni, "attuale" solo sull'ultima tappa...).
//   3. Soglie sui difetti "statistici" (tappe consecutive dello stesso club,
//      anni che tornano indietro): ne esistono sempre pochi, ma se salgono di
//      colpo vuol dire che una modifica ha rotto qualcosa.
//
// Uso:  node check-data-quality.mjs [percorso/players-data.json]
//       (di default output/players-data.json). Esce con codice 1 se qualcosa fallisce.
import fs from "node:fs";

const FILE = process.argv[2] || "./output/players-data.json";

// Soglie: calibrate sui dati reali con un po' di margine. Se una modifica
// voluta le fa salire, aggiornale dopo aver guardato il perché.
const MIN_PLAYERS = 8000;
const MAX_SAME_CLUB_CONSECUTIVE = 350;
const MAX_YEARS_GOING_BACKWARDS = 40;
const MIN_FAME_SHARE = 0.9;

function strip(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
const GENERIC = new Set(["fc", "cf", "ac", "sc", "afc", "as", "ss", "sv", "fk", "vfb", "vfl", "tsg", "sk", "cd", "ud", "sd", "rc", "us", "ssc", "club", "de", "the"]);
function core(club) {
  const toks = strip(club).split(" ").filter(Boolean);
  const kept = toks.filter((t) => !GENERIC.has(t) && !/^(18|19)\d\d$/.test(t));
  return (kept.length ? kept : toks).join(" ");
}
function span(years) {
  const m = String(years).match(/^(\d{4})(?:\s*[–-]\s*(\d{4}))?$/);
  return m ? { start: Number(m[1]), end: Number(m[2] || m[1]) } : null;
}
const idNum = (p) => { const m = String(p.id).match(/-(\d+)$/); return m ? m[1] : null; };

// Casi noti: id numerico del giocatore + controllo. Ognuno ritorna una stringa
// di errore, oppure null se va bene.
const CASI_NOTI = [
  ["780", "Nzonzi: nome mostrato senza il nome legale lungo", (p) => (/Steven/.test(p.displayName || "") && !/Christ/.test(p.displayName || "")) ? null : `displayName = "${p.displayName}"`],
  ["19209", "Tomori: una sola tappa Chelsea di fila, ultima tappa al Milan e attuale", (p) => {
    for (let i = 1; i < p.career.length; i++) if (core(p.career[i].club) === core(p.career[i - 1].club)) return `due tappe consecutive ${p.career[i].club}`;
    const l = p.career[p.career.length - 1];
    return /milan/i.test(l.club) && l.current === true ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`;
  }],
  ["2495", "Zapata: ultima tappa al Torino e attuale", (p) => { const l = p.career[p.career.length - 1]; return /torino/i.test(l.club) && l.current === true ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`; }],
  ["307", "Shaqiri: ultima tappa al Basilea e attuale", (p) => { const l = p.career[p.career.length - 1]; return /basel/i.test(l.club) && l.current === true ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`; }],
  ["790", "Dzeko: ultima tappa allo Schalke e attuale", (p) => { const l = p.career[p.career.length - 1]; return /schalke/i.test(l.club) && l.current === true ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`; }],
  ["105", "Ballo-Toure: niente parentesi vuote, Milan Futuro prima di Le Havre, Metz non attuale", (p) => {
    const names = p.career.map((c) => c.club);
    if (names.some((n) => /\(\s*\)/.test(n))) return "parentesi vuote nel nome del club";
    const iMilan = names.findIndex((n) => /milan futuro/i.test(n)), iHavre = names.findIndex((n) => /le havre/i.test(n));
    if (iMilan < 0 || iHavre < 0 || iMilan > iHavre) return `ordine: ${names.join(" > ")}`;
    const l = p.career[p.career.length - 1];
    return /metz/i.test(l.club) && !l.current ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`;
  }],
  ["1444", "Lichtsteiner: Grasshopper una sola volta", (p) => p.career.filter((c) => /grasshopper/i.test(c.club)).length === 1 ? null : `${p.career.filter((c) => /grasshopper/i.test(c.club)).length} tappe Grasshopper`],
  ["544", "Noa Lang: ordine Napoli > Galatasaray > Napoli", (p) => {
    const n = p.career.map((c) => c.club).filter((c) => /napoli|galatasaray/i.test(c)).map((c) => /napoli/i.test(c) ? "N" : "G").join("");
    return n.endsWith("NGN") ? null : `ordine: ${n}`;
  }],
  ["30758", "Meggiorini: nessuna tappa che arriva al 2027 da ritirato", (p) => p.career.some((c) => (span(c.years) || {}).end >= 2027) ? "tappa fino al 2027" : null],
  ["47516", "Aleix Garcia: nessuna tappa 'Squadra sconosciuta'", (p) => p.career.some((c) => /sconosciuta/i.test(c.club)) ? "c'e' ancora una tappa senza nome" : null],
  ["37651", "Idzes: ultima tappa al Sassuolo e attuale", (p) => { const l = p.career[p.career.length - 1]; return /sassuolo/i.test(l.club) && (l.current === true || (span(l.years) || {}).end >= 2027) ? null : `ultima tappa: ${l.years} ${l.club} current=${l.current}`; }]
];

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);

let data;
try { data = JSON.parse(fs.readFileSync(FILE, "utf-8")); } catch (e) { console.error(`Non riesco a leggere ${FILE}: ${e.message}`); process.exit(1); }
const players = Array.isArray(data.players) ? data.players : [];

// --- Regole sempre valide ---
if (players.length < MIN_PLAYERS) fail(`Pochi giocatori: ${players.length} (minimo ${MIN_PLAYERS})`);

let badYears = 0, emptyParens = 0, noCareer = 0, currentNotLast = 0, sameClub = 0, backwards = 0, noFame = 0;
const examples = { badYears: [], emptyParens: [], sameClub: [], backwards: [], currentNotLast: [] };
const keep = (arr, s) => { if (arr.length < 5) arr.push(s); };

for (const p of players) {
  if (!Array.isArray(p.career) || p.career.length === 0) { noCareer++; continue; }
  if (!(p.fame > 0)) noFame++;
  p.career.forEach((c, i) => {
    const sp = span(c.years);
    if (!sp || sp.end < sp.start) { badYears++; keep(examples.badYears, `${p.name}: "${c.years}" ${c.club}`); }
    if (/\(\s*\)/.test(c.club || "")) { emptyParens++; keep(examples.emptyParens, `${p.name}: "${c.club}"`); }
    if (c.current && i !== p.career.length - 1) { currentNotLast++; keep(examples.currentNotLast, p.name); }
    if (i > 0) {
      const prev = p.career[i - 1], a = span(prev.years);
      if (core(c.club) === core(prev.club)) { sameClub++; keep(examples.sameClub, `${p.name}: ${prev.years} ${prev.club} | ${c.years} ${c.club}`); }
      if (sp && a && sp.start < a.start - 1) { backwards++; keep(examples.backwards, `${p.name}: ${prev.years} ${prev.club} | ${c.years} ${c.club}`); }
    }
  });
}
if (noCareer > 0) fail(`${noCareer} giocatori senza carriera`);
if (badYears > 0) fail(`${badYears} tappe con anni non validi. Esempi: ${examples.badYears.join(" | ")}`);
if (emptyParens > 0) fail(`${emptyParens} nomi di club con parentesi vuote. Esempi: ${examples.emptyParens.join(" | ")}`);
if (currentNotLast > 0) fail(`${currentNotLast} giocatori con "attuale" su una tappa che non è l'ultima. Esempi: ${examples.currentNotLast.join(", ")}`);
if (sameClub > MAX_SAME_CLUB_CONSECUTIVE) fail(`Troppe tappe consecutive dello stesso club: ${sameClub} (massimo ${MAX_SAME_CLUB_CONSECUTIVE}). Esempi: ${examples.sameClub.join(" | ")}`);
if (backwards > MAX_YEARS_GOING_BACKWARDS) fail(`Troppe tappe con anni che tornano indietro: ${backwards} (massimo ${MAX_YEARS_GOING_BACKWARDS}). Esempi: ${examples.backwards.join(" | ")}`);
const fameShare = 1 - noFame / Math.max(1, players.length);
if (fameShare < MIN_FAME_SHARE) fail(`Fama mancante per troppi giocatori: ${(fameShare * 100).toFixed(1)}% ne ha una (minimo ${MIN_FAME_SHARE * 100}%)`);

// --- Casi noti ---
const byNum = new Map(players.map((p) => [idNum(p), p]));
for (const [id, label, check] of CASI_NOTI) {
  const p = byNum.get(id);
  if (!p) { notes.push(`(caso noto ${id} "${label}": giocatore non presente nel gioco, controllo saltato)`); continue; }
  let r; try { r = check(p); } catch (e) { r = `errore nel controllo: ${e.message}`; }
  if (r) fail(`Caso noto - ${label}: ${r}`);
}

console.log(`Giocatori: ${players.length} | tappe consecutive stesso club: ${sameClub} (max ${MAX_SAME_CLUB_CONSECUTIVE}) | anni indietro: ${backwards} (max ${MAX_YEARS_GOING_BACKWARDS}) | con fama: ${(fameShare * 100).toFixed(1)}%`);
notes.forEach((n) => console.log(n));
if (failures.length > 0) {
  console.error(`\nCONTROLLI FALLITI (${failures.length}):`);
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("Controlli di qualità superati.");
