// Mostra, per uno o più giocatori cercati per nome, tutto quello che serve
// per capire perché un verdetto è "fail": la carriera che abbiamo noi, il
// verdetto con le tappe segnate come mancanti, e le tappe lette da Wikipedia.
// Non scrive nulla.
//
// Uso: node show-player.mjs "Schmelzer" "Hakimi"
import fs from "node:fs/promises";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.log('Uso: node show-player.mjs "Cognome" ["Altro cognome" ...]');
  process.exit(1);
}

const raw = JSON.parse(await fs.readFile("./raw-players.json", "utf-8"));
const check = JSON.parse(await fs.readFile("./wikipedia-check.json", "utf-8"));
const careers = new Map();
try {
  (await fs.readFile("./wikipedia-careers.jsonl", "utf-8")).split("\n").forEach((line) => {
    if (!line.trim()) return;
    try { const r = JSON.parse(line); careers.set(String(r.id), r); } catch {}
  });
} catch {}

for (const n of names) {
  const found = raw.players.filter((p) => p.name.toLowerCase().includes(n.toLowerCase()));
  if (found.length === 0) { console.log(`\nNessun giocatore trovato per "${n}"`); continue; }
  for (const p of found.slice(0, 3)) {
    console.log("\n" + "=".repeat(70));
    console.log(`${p.name} (id ${p.id}) | displayName: ${p.displayName || "(nessuno)"}`);
    console.log("--- NOSTRA carriera ---");
    [...(p.seasonRecords || [])]
      .sort((a, b) => a.season - b.season)
      .forEach((r) => {
        const span = r.blockToYear != null ? `${r.season}->${r.blockToYear}` : String(r.season);
        console.log(`  ${span.padEnd(10)} ${r.club}  [${r.apps ?? "?"} pres]${r.source === "wikipedia" ? "  [storico]" : ""}`);
      });
    const v = check.checked[p.id];
    console.log(`--- verdetto: ${v ? v.verdict : "mai controllato"} ---`);
    (v?.missing || []).forEach((m) => console.log(`  MANCA: ${m.team} (${m.from}-${m.to}, ${m.position || "?"}, ${m.apps ?? "?"} pres)`));
    const c = careers.get(String(p.id));
    console.log(`--- WIKIPEDIA (${c ? c.wikipediaTitle : "carriera non salvata"}) ---`);
    const entries = c && Array.isArray(c.entries) ? c.entries : [];
    if (c && !entries.length) console.log(`  (nessuna tappa; campi presenti: ${Object.keys(c).join(", ")})`);
    entries.forEach((e) => console.log(`  ${String(e.from) + "-" + String(e.to)}`.padEnd(14) + ` ${e.team}  [${e.apps ?? "?"} pres]`));
  }
}
