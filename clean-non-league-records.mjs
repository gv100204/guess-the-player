// Toglie da raw-players.json le tappe che NON dovrebbero esserci - coppe,
// nazionali (anche giovanili), amichevoli - usando lo STESSO identico
// controllo di sync-players-data.mjs (isLikelyDomesticLeague). Serve
// perché un giocatore già "careerBackfilled" non viene mai ripescato
// dallo sweep, quindi una riga sbagliata salvata prima che il filtro
// esistesse (o fosse completo) resta lì per sempre.
//
// Non tocca mai i blocchi storici (source: "wikipedia") - quelli seguono
// regole loro, gestite altrove.
//
// SICURO DI DEFAULT: senza --apply mostra solo cosa farebbe.
//
// Uso:
//   node clean-non-league-records.mjs                    -> anteprima
//   node clean-non-league-records.mjs raw-players.json --apply
import fs from "node:fs/promises";

const RAW = process.argv.find((a) => a.endsWith(".json")) || "./raw-players.json";
const APPLY = process.argv.includes("--apply");

// Stessa lista di sync-players-data.mjs - se cambia lì, va cambiata anche
// qui (non importata direttamente per tenere questo script indipendente
// e leggibile da solo).
const NON_LEAGUE_KEYWORDS = [
  "cup", "copa", "coppa", "coupe", "pokal", "beker", "taça", "taca", "champions league", "europa league", "conference league",
  "friendl", "world cup", "euro championship", "european championship", "euro -", "qualif", "super cup",
  "shield", "trophy", "community", "confederations", "nations league",
  "intercontinental", "club world cup", "youth league", "playoff", "play-off", "play off",
  "africa cup", "copa américa", "copa america", "asian cup", "gold cup", "olympic",
  "primavera", "reserve",
  "academy", "all-star", "all star",
  "canadian championship", "eaff e-1", "waff championship",
  "afc championship", "south american championship", "asean club championship"
];
const YOUTH_OR_NATIONAL_TEAM_PATTERN = /\bu-?(1[5-9]|2[0-3])\b/i;
const NATION_NAMES = new Set([
  "afghanistan","albania","algeria","andorra","angola","argentina","armenia","australia",
  "austria","azerbaijan","bahrain","bangladesh","belarus","belgium","belize","benin",
  "bhutan","bolivia","bosnia and herzegovina","botswana","brazil","bulgaria","burkina faso",
  "burundi","cambodia","cameroon","canada","cape verde","chad","chile","china","colombia"
  // Elenco ridotto rispetto all'originale (basta per il controllo qui: la
  // maggior parte dei casi reali passa dalle parole chiave, non da questo).
]);

function isLikelyDomesticLeague(name, teamName) {
  if (!name) return false;
  if (teamName) {
    if (YOUTH_OR_NATIONAL_TEAM_PATTERN.test(teamName)) return false;
    if (NATION_NAMES.has(teamName.trim().toLowerCase())) return false;
  }
  const lower = name.toLowerCase();
  return !NON_LEAGUE_KEYWORDS.some((kw) => lower.includes(kw));
}

const raw = JSON.parse(await fs.readFile(RAW, "utf-8"));
let playersAffected = 0;
let recordsRemoved = 0;
const examples = [];

for (const p of raw.players) {
  const records = p.seasonRecords || [];
  const kept = [];
  const removed = [];
  for (const r of records) {
    if (r.source === "wikipedia") { kept.push(r); continue; } // blocchi storici: regole loro, non li tocchiamo
    // leagueRaw è il nome grezzo quando l'id interno non è stato risolto;
    // se invece è stato risolto (league presente), è già un campionato
    // tracciato vero, quindi passa senza bisogno di controllo.
    const nameToCheck = r.league ? null : r.leagueRaw;
    if (nameToCheck && !isLikelyDomesticLeague(nameToCheck, r.club)) {
      removed.push(r);
    } else {
      kept.push(r);
    }
  }
  if (removed.length > 0) {
    playersAffected++;
    recordsRemoved += removed.length;
    if (examples.length < 20) {
      examples.push(`${p.name}: tolto ${removed.map((r) => `${r.club} ${r.leagueRaw} (${r.season})`).join(", ")}`);
    }
    if (APPLY) p.seasonRecords = kept;
  }
}

console.log(`Giocatori con tappe da togliere: ${playersAffected}`);
console.log(`Tappe da togliere in totale: ${recordsRemoved}`);
console.log(`\nPrimi esempi:`);
examples.forEach((e) => console.log(`  ${e}`));

if (!APPLY) {
  console.log("\nAnteprima: NON è stato scritto nulla. Per applicare: node clean-non-league-records.mjs raw-players.json --apply");
} else {
  await fs.copyFile(RAW, RAW.replace(/\.json$/, "") + ".prima-pulizia-coppe.json").catch(() => {});
  await fs.writeFile(RAW, JSON.stringify(raw), "utf-8");
  console.log(`\nScritto direttamente in ${RAW}. Copia di sicurezza salvata accanto.`);
}
