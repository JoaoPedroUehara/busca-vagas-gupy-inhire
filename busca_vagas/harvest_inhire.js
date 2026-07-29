// Coleta slugs de tenants InHire da web aberta (Wayback + urlscan + Common Crawl).
// Gera: wb_app.txt, us_app_paged.json, cc_app.jsonl  (consumidos por validate_inhire.js)
const fs = require('fs'), path = require('path');
const { pool } = require('./lib.js');
const DIR = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function wayback() {
  console.log('[wayback] baixando CDX *.inhire.app ...');
  try {
    const t = await getText('http://web.archive.org/cdx/search/cdx?url=*.inhire.app&output=text&fl=original&collapse=urlkey&limit=200000');
    fs.writeFileSync(path.join(DIR, 'wb_app.txt'), t);
    const hosts = new Set((t.match(/https?:\/\/[a-z0-9-]+\.inhire\.app/gi) || []).map(x => x.replace(/^https?:\/\//, '').toLowerCase()));
    console.log('[wayback] hosts unicos:', hosts.size);
  } catch (e) { console.log('[wayback] falhou:', e.message); }
}

async function urlscan() {
  console.log('[urlscan] paginando domain:inhire.app ...');
  const base = 'https://urlscan.io/api/v1/search/?q=domain:inhire.app&size=100';
  let after = '', all = [];
  try {
    for (let i = 0; i < 6; i++) {
      const url = base + (after ? '&search_after=' + after : '');
      const r = await fetch(url); const j = await r.json();
      const res = j.results || []; all = all.concat(res);
      if (res.length < 100) break;
      after = (res[res.length - 1].sort || []).join(',');
      await sleep(1500);
    }
  } catch (e) { console.log('[urlscan] parou:', e.message); }
  fs.writeFileSync(path.join(DIR, 'us_app_paged.json'), JSON.stringify({ results: all }));
  console.log('[urlscan] resultados:', all.length);
}

async function commonCrawl(nIndexes = 12) {
  console.log('[commoncrawl] descobrindo indices ...');
  let indexes = [];
  try {
    const info = JSON.parse(await getText('https://index.commoncrawl.org/collinfo.json'));
    indexes = info.slice(0, nIndexes).map(x => x.id);
  } catch (e) { console.log('[commoncrawl] collinfo falhou:', e.message); return; }
  // Indices sao independentes entre si -> consulta em paralelo (pool modesto para nao
  // martelar o index.commoncrawl.org). Ordena a saida pelo indice original so para o
  // arquivo continuar deterministico entre rodadas.
  const parts = await pool(indexes, async (idx) => {
    try {
      const t = await getText(`https://index.commoncrawl.org/${idx}-index?url=*.inhire.app&output=json&fl=url`);
      process.stdout.write(`  [commoncrawl] ${idx} ok\n`);
      return t.endsWith('\n') ? t : t + '\n';
    } catch (e) { process.stdout.write(`  [commoncrawl] ${idx} vazio/erro\n`); return ''; }
  }, 4);
  const body = parts.filter(p => typeof p === 'string' && p).join('');
  fs.writeFileSync(path.join(DIR, 'cc_app.jsonl'), body);
  console.log('[commoncrawl] linhas:', body.split(/\n/).filter(Boolean).length);
}

(async () => {
  // As tres fontes batem em hosts diferentes e escrevem arquivos diferentes -> paralelo.
  await Promise.all([wayback(), urlscan(), commonCrawl(12)]);
  console.log('[harvest] concluido -> wb_app.txt, us_app_paged.json, cc_app.jsonl');
})();
