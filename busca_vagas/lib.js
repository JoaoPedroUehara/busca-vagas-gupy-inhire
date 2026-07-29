// Shared helpers
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function loadCompanies() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'companies.json'), 'utf8').replace(/^﻿/, ''));
  return raw.map(s => String(s).trim()).filter(Boolean);
}

// normalize: lowercase, strip accents, keep only a-z0-9 (compact)
function compact(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '');
}
// tokens (words) normalized, dropping generic corporate tokens
const STOP = new Set(['sa','s','a','ltda','me','eireli','group','grupo','the','company','co','tecnologia','tech','brasil','brazil','do','de','da','dos','das','and','solutions','software','digital','inc','holding','participacoes','banco']);
function tokens(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/).filter(t => t && !STOP.has(t));
}

// Mercado Financeiro: stems (sem espaço final) para casar flexões (financeiro/financeira/financeiramente...).
const FINANCE_RE = new RegExp([
  // ' financ' cobre financeiro/financeira/finanças/finance/financial/financiamento
  ' financ', ' investiment', ' tesourari', ' mercado financeiro ',
  ' renda fixa ', ' renda variavel ', ' credito', ' controladoria',
  ' fp a ', ' fpa ', ' asset management ', ' wealth management ',
  ' corporate finance ', ' middle office ', ' back office ',
  ' contabil', ' contas a pagar ', ' contas a receber '
].join('|'));

// Casamento mais frouxo de dados/analytics, usado só como gate para vagas de Trainee
// (o título de Trainee costuma ser curto e não segue a ordem de palavras dos padrões abaixo).
const DATA_LOOSE_RE = new RegExp([
  ' dados', ' analytics', ' business intelligence ', ' bi ',
  ' insights', ' growth ', ' inteligencia de mercado ',
  ' inteligencia de negocios ', ' revenue operations ', ' revops '
].join('|'));

// Role matching against a job title. Returns canonical role label or null.
function matchRole(title) {
  const t = ' ' + String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const has = (re) => re.test(t);
  // Trainee é transversal: só interessa se for de Mercado Financeiro ou Dados/Analytics
  // (corta trainee de área não relacionada — industrial, mecânica, agro, jurídico etc.).
  if (has(/ trainee /)) {
    if (FINANCE_RE.test(t)) return 'Trainee — Mercado Financeiro';
    if (DATA_LOOSE_RE.test(t)) return 'Trainee — Dados/Analytics';
    return null;
  }
  if (FINANCE_RE.test(t)) return 'Mercado Financeiro';
  if (has(/ revenue operations /) || has(/ revops /) || has(/ revenue ops /)) return 'Revenue Operations / RevOps';
  if (has(/ growth /)) return 'Growth Analyst / Analista de Growth';
  if (has(/ analista de insights /) || has(/ insights analyst /) || (has(/ insights /) && has(/ analista /))) return 'Analista de Insights';
  if (has(/ inteligencia de mercado /) || has(/ market intelligence /) || (has(/ intelligence /) && has(/ market /))) return 'Analista de Inteligência de Mercado';
  if (has(/ analista de negocios /) || has(/ business analyst /)) return 'Business Analyst / Analista de Negócios';
  if (has(/ inteligencia de negocios /) || has(/ analista de bi /) || has(/ bi analyst /) || has(/ business intelligence /) || has(/ analista de business intelligence /) || has(/ analista bi /)) return 'BI / Business Intelligence';
  if (has(/ analista de dados /) || has(/ data analyst /) || has(/ analista de dados e /)) return 'Analista de Dados / Data Analyst';
  return null;
}

// URL slug from a job title (lowercase, strip accents, non-alnum -> hyphen).
// The InHire SPA route is /vagas/:jobId/:slug — without the :slug segment the
// client router fails to resolve and renders a black screen. The slug is cosmetic
// (job loads by jobId), so any non-empty slug works.
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'vaga';
}

// Formata data/data-hora ISO para "DD/MM/AAAA" (sem horário). Usa métodos UTC para não deslocar
// o dia por causa do fuso local (ex.: "2026-09-27" não pode virar 26/09 num fuso atrás de UTC).
function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

function isRemote(workplaceType, isRemoteWork) {
  const w = String(workplaceType || '').toLowerCase();
  if (isRemoteWork === true) return true;
  return w.includes('remote') || w.includes('remoto');
}

// Local em Brasília/DF, a partir de texto livre (cidade, estado, "Cidade, UF, BR" etc.).
function isBrasiliaDF(locationText) {
  const n = ' ' + String(locationText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  return / df | distrito federal | brasilia /.test(n);
}

// Política de localização do pipeline: aceita vaga 100% remota OU presencial/híbrida em Brasília-DF.
function isAllowedLocation(workplaceType, locationText) {
  if (isRemote(workplaceType)) return true;
  return isBrasiliaDF(locationText);
}

// --- Agregadores de PROGRAMA (Cia de Talentos, Eureca) -----------------------------------
// Aqui o titulo e o nome do programa/area, nao um cargo: "Trainee em Financas", "Estagio em
// Dados e Analytics", ou o generico "Programa de Trainee <Empresa> 2026". Por isso matchRole()
// (que espera cargo tipo "Analista de Dados") passa longe, e o casamento e por AREA.

// Casamento frouxo de area — aceita "Financas", "Dados e Analytics", "Tecnologia & Dados".
function matchAreaLoose(title) {
  const t = ' ' + String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (FINANCE_RE.test(t)) return 'Mercado Financeiro';
  if (DATA_LOOSE_RE.test(t)) return 'Dados / Analytics';
  return null;
}

// Palavras que compoem o "esqueleto" de um nome de programa e nao dizem area nenhuma.
const PROGRAM_FILLER = new Set([
  'programa', 'programas', 'trainee', 'trainees', 'estagio', 'estagios', 'estagiario',
  'jovem', 'aprendiz', 'em', 'para', 'com', 'novo', 'nova', 'novos', 'geracao', 'gen',
  'edicao', 'ciclo', 'semestre', 'primeiro', 'segundo', 'superior', 'tecnico', 'nivel',
  'vaga', 'vagas', 'oportunidade', 'oportunidades', 'talentos', 'banco', 'mentoria',
  'lider', 'lideres', 'liderança', 'lideranca', 'futuro', 'futuros', 'carreira', 'carreiras',
  // marcadores de "area nao especificada" que as APIs devolvem como se fossem area
  'diversa', 'diversas', 'diverso', 'diversos', 'geral', 'generalista', 'varias', 'varios',
  'multiplas', 'multiplos', 'todas', 'todos', 'localidade', 'area', 'areas'
]);

// Diz se o titulo nomeia uma area ESPECIFICA (ex.: "Trainee em Vendas" -> sim; "Programa de
// Trainee GEQ 2026" -> nao). Serve para separar "programa generalista, area a confirmar" de
// "programa de outra area" — o primeiro entra na planilha, o segundo nao.
// O nome da empresa entra como filler para nao ser confundido com area.
function namesSpecificArea(title, companyName) {
  const companyToks = new Set(tokens(companyName || ''));
  const rest = tokens(title).filter(tk =>
    !PROGRAM_FILLER.has(tk) &&
    !companyToks.has(tk) &&
    !/^\d+$/.test(tk) &&  // anos (2026, 2027) e numeros de edicao
    tk.length > 3         // siglas da empresa (GEQ, PwC, ADM, EY) nao sao area.
                          // Areas de sigla curta (BI, TI) ja foram pegas por matchAreaLoose antes.
  );
  return rest.length > 0;
}

// Localidade "indefinida" nos agregadores de programa ("Localidade: Diversas", vazio, "Brasil",
// "Nacional"). Nao da pra afirmar que atende Brasilia/remoto, mas tambem nao da pra descartar —
// programa nacional costuma incluir varias pracas. Essas linhas entram com alerta.
function isLocationUnspecified(locationText) {
  const t = String(locationText || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  if (!t) return true;
  return /divers|nacional|todo o brasil|^brasil$|varias|a definir|nao informad/.test(t);
}

// Senioridade aceita: Assistente, Auxiliar, Júnior/Jr, ou no máximo nível "I" (ex.: "Analista I").
// Qualquer marcador de nível acima disso é cortado mesmo que o título também tenha um "I" solto
// (evita falso positivo tipo "Analista Financeiro Sênior - Regional I"). Trainee fica de fora
// desta checagem — matchRole() já isola esse bucket, e trainee é entry-level por definição.
const SENIOR_RE = / pleno| plena| senior| sr | especialista| coordenad| supervisor| gerente| gerencia| diretor| head | lead | principal| master| ii | iii | iv | v /;
const ENTRY_RE = / assistente| auxiliar| junior | jr | i /;
function isEntryLevel(title) {
  const t = ' ' + String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (SENIOR_RE.test(t)) return false;
  return ENTRY_RE.test(t);
}

// Fábrica de matcher empresa-alvo -> nome como aparece na plataforma (exato ou substring forte).
function buildCompanyMatcher(companies) {
  const listCompact = companies.map(c => ({ orig: c, c: compact(c) })).filter(x => x.c.length >= 2);
  return function matchCompany(name) {
    const cp = compact(name);
    if (!cp) return null;
    let hit = listCompact.find(x => x.c === cp);
    if (hit) return hit.orig;
    hit = listCompact.find(x => (x.c.length >= 5 && cp.includes(x.c)) || (cp.length >= 5 && x.c.includes(cp)));
    return hit ? hit.orig : null;
  };
}

// simple concurrency pool
async function pool(items, worker, concurrency = 12) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { __error: String(e && e.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { DIR, loadCompanies, compact, tokens, matchRole, slugify, isRemote, isBrasiliaDF, isAllowedLocation, isEntryLevel, matchAreaLoose, namesSpecificArea, isLocationUnspecified, buildCompanyMatcher, formatDateBR, pool, sleep, STOP };
