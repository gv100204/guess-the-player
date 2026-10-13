import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GAME_FILE = path.join(here, "..", "indovina-calciatore.html");
const WWW = path.join(here, "www");
const DATA = path.join(WWW, "data");
const PUBLISHED = "https://gv100204.github.io/guess-the-player/";

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--from-dir");
const fromDir = dirIdx >= 0 ? path.resolve(args[dirIdx + 1]) : null;

async function getText(name) {
  if (fromDir) return fs.readFile(path.join(fromDir, name), "utf-8");
  const res = await fetch(PUBLISHED + name, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.text();
}

await fs.rm(WWW, { recursive: true, force: true });
await fs.mkdir(DATA, { recursive: true });

let html = await fs.readFile(GAME_FILE, "utf-8");
const marker = "<script>";
const idx = html.indexOf(marker);
if (idx < 0) throw new Error("Non trovo il tag <script> nel gioco.");
const inject = '<script>window.MANYSHIRTS_DATA_BASE = "./data/";</script>\n';
html = html.slice(0, idx) + inject + html.slice(idx);
await fs.writeFile(path.join(WWW, "index.html"), html, "utf-8");
console.log("Gioco copiato in www/index.html");

const manifestText = await getText("manifest.json");
await fs.writeFile(path.join(DATA, "manifest.json"), manifestText, "utf-8");
const manifest = JSON.parse(manifestText);
let total = 0;
for (const [id, info] of Object.entries(manifest.leagues || {})) {
  const text = await getText(info.file);
  await fs.writeFile(path.join(DATA, info.file), text, "utf-8");
  total += text.length;
  console.log(`  ${id}: ${info.file} (${(text.length / 1e6).toFixed(1)} MB, ${info.count} giocatori)`);
}
console.log(`Dati in www/data/: ${Object.keys(manifest.leagues || {}).length} campionati, ${(total / 1e6).toFixed(1)} MB, versione ${manifest.version}`);
console.log("Fatto. Ora: npx cap sync");
