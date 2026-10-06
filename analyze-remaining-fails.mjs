// Dopo il rattoppo, guarda i giocatori ancora "fail" e li raggruppa per il
// tipo di tappa che manca, così si può decidere con i dati se la regola del
// verdetto o quella dei blocchi "coperti da un altro club" vada ammorbidita.
//
// Categorie (per giocatore, vince la più grave):
//   buco vero             - manca una tappa e nei nostri dati NON c'è nessun altro club in quegli anni
//   sovrapposta ad altro  - la tappa mancante cade su anni già occupati da un altro club
//   solo riserve/giovanili - tutte le tappe mancanti sono seconde squadre o giovanili
//
// Non scrive nulla. Uso: node analyze-remaining-fails.mjs
import fs from "node:fs/promises";

const check = JSON.parse(await fs.readFile("./wikipedia-check.json", "utf-8"));
const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));
const byId = new Map(raw.players.map((p) => [String(p.id), p]));

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isReserve = (team) => /(^|\s)(ii|iii|b|c)$/.test(norm(team)) || /\b(u ?\d{2}|reserves?|youth|primavera|academy|juvenil|jong|amateurs?)\b/.test(norm(team));

function classify(player, m) {
  const sameClub = (r) => norm(r.club) === norm(m.team);
  const overlapsOther = (player.seasonRecords || []).some((r) => {
    if (sameClub(r)) return false;
    const rFrom = r.season, rTo = r.blockToYear != null ? r.blockToYear : r.season;
    return m.from < rTo && rFrom < m.to;
  });
  if (isReserve(m.team)) return "solo riserve/giovanili";
  if (overlapsOther) return "sovrapposta ad altro club";
  return "buco vero";
}

const order = ["buco vero", "sovrapposta ad altro club", "solo riserve/giovanili"];
const groups = { "buco vero": [], "sovrapposta ad altro club": [], "solo riserve/giovanili": [] };
let fails = 0, noPlayer = 0;

for (const [id, v] of Object.entries(check.checked)) {
  if (v.verdict !== "fail") continue;
  const p = byId.get(String(id));
  if (!p) { noPlayer++; continue; }
  fails++;
  // tappe ancora non coperte dopo il rattoppo (i blocchi aggiunti contano come presenti)
  const stillMissing = (v.missing || []).filter((m) => {
    return !(p.seasonRecords || []).some((r) => r.source === "wikipedia" && norm(r.club) === norm(m.team) && r.season <= m.from + 1 && (r.blockToYear ?? r.season) >= m.to - 1);
  });
  if (stillMissing.length === 0) continue;
  const cats = stillMissing.map((m) => ({ m, cat: classify(p, m) }));
  const worst = order.find((c) => cats.some((x) => x.cat === c));
  const example = cats.find((x) => x.cat === worst).m;
  groups[worst].push(`${v.name}: ${example.team} (${example.from}-${example.to}, ${example.position || "?"})`);
}

console.log(`Giocatori ancora fail: ${fails}${noPlayer ? ` (+${noPlayer} non più nei dati)` : ""}\n`);
for (const c of order) {
  console.log(`${c}: ${groups[c].length}`);
  groups[c].slice(0, 8).forEach((e) => console.log(`   ${e}`));
  console.log("");
}
