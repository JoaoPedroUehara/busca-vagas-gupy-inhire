const fs = require('fs');
const path = require('path');
const { DIR, loadCompanies, matchRole, isAllowedLocation, isEntryLevel, buildCompanyMatcher, pool, sleep } = require('./lib.js');

const QUERIES = [
  'Analista de Dados', 'Data Analyst', 'Analista de BI', 'Business Intelligence',
  'Business Analyst', 'Analista de Negócios', 'Inteligência de Negócios',
  'Growth', 'Revenue Operations', 'RevOps', 'Analista de Insights',
  'Inteligência de Mercado', 'Market Intelligence',
  // Mercado Financeiro
  'Analista Financeiro', 'Financial Analyst', 'Analista de Investimentos',
  'Tesouraria', 'Analista de Risco', 'Analista de Crédito', 'Controladoria', 'FP&A',
  // Trainee (Financeiro/Dados) — matchRole() corta o que não for dessas áreas
  'Trainee', 'Programa Trainee', 'Trainee Financeiro'
];

const API = 'https://employability-portal.gupy.io/api/v1/jobs';

async function fetchPage(q, offset, limit) {
  const url = `${API}?jobName=${encodeURIComponent(q)}&offset=${offset}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${q}@${offset}`);
  return res.json();
}

async function fetchAll(q) {
  // NOTE: the API's pagination.total is unreliable (caps at `limit` when limit>=100),
  // but offset paging works. Page until a page returns fewer than `limit` rows.
  const limit = 100;
  const MAX_OFFSET = 3000; // safety cap
  let offset = 0, out = [];
  while (offset <= MAX_OFFSET) {
    let json;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { json = await fetchPage(q, offset, limit); break; }
      catch (e) { if (attempt === 2) throw e; await sleep(800); }
    }
    const data = json.data || [];
    out.push(...data);
    if (data.length < limit) break; // last page
    offset += limit;
    await sleep(120);
  }
  return { total: out.length, jobs: out };
}

(async () => {
  const companies = loadCompanies();
  const matchCompany = buildCompanyMatcher(companies);

  const byId = new Map();
  const wpValues = new Set();
  // Os termos de busca sao independentes -> em paralelo (pool modesto: a paginacao de cada
  // termo continua sequencial, entao a carga real na API da Gupy segue baixa).
  const porQuery = await pool(QUERIES, async (q) => {
    const { jobs } = await fetchAll(q);
    console.log(`  [gupy] "${q}" ... fetched=${jobs.length}`);
    return jobs;
  }, 6);
  for (const jobs of porQuery) {
    if (!Array.isArray(jobs)) continue; // pool devolve {__error} se o termo falhou
    for (const j of jobs) byId.set(j.id, j); // dedup entre termos
  }
  console.log(`[gupy] unique jobs pooled: ${byId.size}`);

  const results = [];
  let locOkCount = 0, roleCount = 0, entryOkCount = 0, inList = 0, outList = 0;
  for (const j of byId.values()) {
    wpValues.add(j.workplaceType);
    const role = matchRole(j.name);
    if (!role) continue;
    roleCount++;
    if (!role.startsWith('Trainee') && !isEntryLevel(j.name)) continue;
    entryOkCount++;
    const location = [j.city, j.state, j.country].filter(Boolean).join(' / ');
    if (!isAllowedLocation(j.workplaceType, location)) continue;
    locOkCount++;
    const company = matchCompany(j.careerPageName);
    if (company) inList++; else outList++;
    results.push({
      platform: 'Gupy',
      companyList: company || j.careerPageName, // fora da lista: usa o nome da career page como rótulo
      companyGupy: j.careerPageName,
      na_lista: company ? 'Sim' : 'Não',        // simétrico à InHire: inclui fora-da-lista marcado
      role,
      jobTitle: j.name,
      workplaceType: j.workplaceType,
      location,
      url: j.jobUrl || (j.careerPageUrl ? j.careerPageUrl : ''),
      publishedDate: j.publishedDate || '',
      deadline: j.applicationDeadline || '' // prazo final de inscricao; so a Gupy expoe esse campo
    });
  }
  console.log(`[gupy] workplaceType values seen: ${[...wpValues].join(', ')}`);
  console.log(`[gupy] role-matched=${roleCount} nivel-entry-ok=${entryOkCount} local-ok(remoto/Brasília-DF)=${locOkCount} -> rows=${results.length} (in-list=${inList}, fora-da-lista=${outList})`);
  fs.writeFileSync(path.join(DIR, 'gupy_results.json'), JSON.stringify(results, null, 2));
  console.log(`[gupy] wrote ${results.length} rows -> gupy_results.json`);

  // presence: distinct in-list companies that have ANY active job in Gupy (from the pooled search)
  const presence = new Map();
  for (const j of byId.values()) {
    const company = matchCompany(j.careerPageName);
    if (!company) continue;
    if (!presence.has(company)) presence.set(company, { empresa: company, nome_na_plataforma: j.careerPageName, vagas_no_pool: 0 });
    presence.get(company).vagas_no_pool++;
  }
  const presenceArr = [...presence.values()].sort((a,b)=>a.empresa.localeCompare(b.empresa));
  fs.writeFileSync(path.join(DIR, 'gupy_presence.json'), JSON.stringify(presenceArr, null, 2));
  console.log(`[gupy] in-list companies present in Gupy search pool: ${presenceArr.length}`);
})();
