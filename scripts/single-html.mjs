// Inlines dist-single/ into one self-contained HTML file: CSS and the app bundle go
// inline, and each Web Worker becomes a blob: URL built from its inlined source.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist-single';
const out = process.argv[3] ?? join(dir, 'caseblanket.html');
const assets = join(dir, 'assets');
const files = readdirSync(assets);
let html = readFileSync(join(dir, 'index.html'), 'utf8');
const js = files.filter((f) => f.endsWith('.js') && !/worker/i.test(f));
if (js.length !== 1) throw new Error(`expected one app chunk, got ${js.join(', ')}`);
let app = readFileSync(join(assets, js[0]), 'utf8');

// Worker chunks have no imports, so they run as classic workers: module workers from
// blob: URLs fail to start when the page is opened from file:// (opaque origin).
const workerRe = /new URL\(new URL\(`([^`]+)`,import\.meta\.url\)\.href,``\+import\.meta\.url\),\{type:`module`\}/g;
const used = new Set();
app = app.replace(workerRe, (_, name) => {
  used.add(name);
  return `__cbWorker(${JSON.stringify(name)})`;
});
for (const n of used) {
  // Statements only: the words themselves can appear in strings (e.g. an exported file's header).
  const src = readFileSync(join(assets, n), 'utf8');
  if (/(?:^|[;}\n])\s*(?:import\s*[\w{*"'`]|export\s*[\w{*])|\bimport\s*\(|\bimport\.meta\b/.test(src)) throw new Error(`${n} is a module, cannot run as a classic worker`);
}
const sources = Object.fromEntries([...used].map((n) => [n, readFileSync(join(assets, n), 'utf8')]));
const prelude =
  `const __cbSrc=${JSON.stringify(sources).replace(/<\/script/gi, '<\\/script')};` +
  `const __cbUrl={};const __cbWorker=(n)=>__cbUrl[n]??=URL.createObjectURL(new Blob([__cbSrc[n]],{type:'text/javascript'}));\n`;
if (/import\(`\.\/|from"\.\//.test(app)) throw new Error('app chunk still imports other chunks');

const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
html = html.replace(/<script type="module" crossorigin src="[^"]+"><\/script>/, () => `<script type="module">${safe(prelude + app)}</script>`);
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/assets\/([^"]+)">/, (_, f) => `<style>${readFileSync(join(assets, f), 'utf8')}</style>`);
if (/src="\.\/assets|href="\.\/assets/.test(html)) throw new Error('unresolved asset reference left in HTML');
writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} kB, ${used.size} workers inlined`);
