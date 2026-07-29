const fs = require('fs');
const path = require('path');
const { DIR, loadCompanies, compact, tokens, sleep, pool } = require('./lib.js');

function slugVariants(name) {
  const allToks = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const toks = tokens(name);
  const set = new Set();
  const add = v => { if (v && v.length >= 2 && v.length <= 40) set.add(v); };
  add(compact(name)); add(allToks.join('')); add(toks.join(''));
  add(allToks.join('-')); add(toks.join('-'));
  if (toks[0]) add(toks[0]);
  if (allToks[0]) add(allToks[0]);
  return [...set];
}
function titleMatches(company, title) {
  const a = new Set(tokens(company)), b = new Set(tokens(title));
  for (const t of a) if (b.has(t) && t.length >= 3) return true;
  const ca = compact(company), cb = compact(title);
  return (ca.length >= 4 && cb.includes(ca)) || (cb.length >= 4 && ca.includes(cb));
}
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

// Le so o inicio do corpo ate achar o </title> (que fica no <head>) e corta o resto.
// As paginas da Gupy sao SPAs de centenas de KB e so precisamos do titulo -> baixar o
// documento inteiro era o gargalo deste passo.
async function readTitle(res, maxBytes = 32768) {
  if (!res.body) return (await res.text()).match(TITLE_RE)?.[1].trim() || '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.length;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(TITLE_RE);
      if (m) return m[1].trim();
    }
  } catch { /* conexao caiu no meio: usa o que deu pra ler */ }
  finally { reader.cancel().catch(() => {}); }
  return buf.match(TITLE_RE)?.[1].trim() || '';
}

// Devolve { titulo } se achou, { ausente:true } se a Gupy respondeu que nao existe, ou
// { incerto:true } se a requisicao falhou (rede caiu, 429, 5xx). A distincao importa: so
// "ausente" pode virar negativo no cache — gravar negativo por falha de rede sumiria com a
// empresa da aba Presenca ate o TTL vencer.
async function probe(slug) {
  try {
    const res = await fetch(`https://${slug}.gupy.io/`, { redirect: 'follow' });
    if (res.status === 429 || res.status >= 500) return { incerto: true };
    if (res.status !== 200) return { ausente: true };
    const title = await readTitle(res);
    if (!title || /^404$/.test(title)) return { ausente: true };
    return { titulo: title };
  } catch { return { incerto: true }; }
}

// Varredura completa de uma empresa: testa cada variante de slug ate achar.
// `incerto` = alguma variante falhou por rede, entao "nao achei" nao e conclusivo.
async function scanCompany(company) {
  let incerto = false;
  for (const slug of slugVariants(company)) {
    const r = await probe(slug);
    if (r.incerto) { incerto = true; continue; }
    if (r.titulo && titleMatches(company, r.titulo)) return { hit: { slug, titulo: r.titulo } };
  }
  return { hit: null, incerto };
}

const CACHE = path.join(DIR, 'gupy_presence_cache.json');
// Empresa SEM pagina na Gupy custa 7 requisicoes (todas as variantes de slug) e e a maioria
// da lista — era isso que fazia este passo levar ~60s. Reconfirmar isso todo dia nao paga:
// empresa entra em ATS raramente. Entao o "nao encontrado" vale por TTL_DIAS; ja o
// "encontrado" e reconferido toda rodada, mas com 1 requisicao so (o slug ja e conhecido).
const TTL_DIAS = 7;
const hoje = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
const diasEntre = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;

(async () => {
  const companies = loadCompanies();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* primeira rodada */ }

  // Separa quem precisa de varredura completa de quem so precisa de reconferencia barata.
  const completo = [], reconferir = [];
  let pulados = 0;
  for (const c of companies) {
    const e = cache[c];
    if (!e) { completo.push(c); continue; }                       // nunca vista
    if (e.encontrado) { reconferir.push(c); continue; }           // 1 requisicao
    if (diasEntre(hoje, e.verificadoEm) >= TTL_DIAS) completo.push(c); // negativo vencido
    else pulados++;                                               // negativo ainda valido
  }
  console.log(`[gupy-presence] ${companies.length} empresas: ${reconferir.length} reconferir, ${completo.length} varredura completa, ${pulados} em cache (negativo < ${TTL_DIAS}d)`);

  const found = [];
  let incertos = 0;
  // `incerto`: a varredura nao achou, mas alguma requisicao falhou por rede -> NAO grava
  // negativo. Mantem o que o cache ja sabia (se sabia) e tenta de novo na proxima rodada.
  const registra = (company, { hit, incerto }) => {
    if (hit) {
      cache[company] = { encontrado: true, slug: hit.slug, titulo: hit.titulo, verificadoEm: hoje };
      found.push({ empresa: company, titulo_gupy: hit.titulo, url: `https://${hit.slug}.gupy.io/` });
      return;
    }
    if (incerto) {
      incertos++;
      const antigo = cache[company];
      // Empresa que ja era conhecida continua na planilha; so nao renova o verificadoEm.
      if (antigo && antigo.encontrado) {
        found.push({ empresa: company, titulo_gupy: antigo.titulo, url: `https://${antigo.slug}.gupy.io/` });
      }
      return;
    }
    cache[company] = { encontrado: false, verificadoEm: hoje };
  };

  // 1) Reconferencia dos positivos: so o slug ja conhecido. Se caiu, faz varredura completa
  //    (a empresa pode ter mudado de slug, nao necessariamente saido da Gupy).
  await pool(reconferir, async (company) => {
    const { slug } = cache[company];
    const r = await probe(slug);
    if (r.titulo && titleMatches(company, r.titulo)) return registra(company, { hit: { slug, titulo: r.titulo } });
    registra(company, await scanCompany(company));
  }, 16);

  // 2) Varredura completa: empresas novas e negativos vencidos.
  let n = 0;
  await pool(completo, async (company) => {
    registra(company, await scanCompany(company));
    if (++n % 150 === 0) process.stdout.write(`  [gupy-presence] varredura ${n}/${completo.length}\n`);
    // NAO aumentar esta concorrencia. Testado em 32: nao ficou mais rapido (52s vs 51s) e
    // ainda ACHOU MENOS empresas (125 vs 130) — a gupy.io comeca a derrubar conexao, e o
    // catch do probe() registra isso como "empresa sem pagina". 16 e o ponto de equilibrio.
  }, 16);

  // Cache so guarda empresas da lista atual (some quem foi removido do empresas.xlsx).
  const daLista = new Set(companies);
  for (const k of Object.keys(cache)) if (!daLista.has(k)) delete cache[k];

  found.sort((a, b) => a.empresa.localeCompare(b.empresa));
  fs.writeFileSync(path.join(DIR, 'gupy_presence_full.json'), JSON.stringify(found, null, 2));
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
  if (incertos) console.log(`[gupy-presence] ${incertos} empresas com falha de rede — nao viraram negativo, serao reconferidas na proxima rodada`);
  console.log(`[gupy-presence] companies with a Gupy career page: ${found.length}/${companies.length}`);
})();
