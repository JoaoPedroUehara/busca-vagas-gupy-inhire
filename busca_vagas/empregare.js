const fs = require('fs');
const path = require('path');
const { DIR, loadCompanies, matchRole, isAllowedLocation, isEntryLevel, buildCompanyMatcher, sleep } = require('./lib.js');

const MCP_URL = 'https://www.empregare.com/api/mcp';
const ITEMS_PER_PAGE = 50;
const MAX_PAGES = 10; // safety cap por termo de busca (ate 500 vagas por termo)

const QUERIES = [
  'Analista de Dados', 'Analista de BI', 'Business Intelligence', 'Business Analyst',
  'Analista de Negócios', 'Growth', 'Revenue Operations', 'Analista de Insights',
  'Inteligência de Mercado',
  // Mercado Financeiro
  'Analista Financeiro', 'Analista de Investimentos', 'Tesouraria', 'Analista de Risco',
  'Analista de Crédito', 'Controladoria', 'Mercado Financeiro',
  // Trainee (Financeiro/Dados) — matchRole() corta o que não for dessas áreas
  'Trainee', 'Programa Trainee', 'Trainee Financeiro', 'Trainee Dados'
];

let rpcId = 0;

// Chama a tool MCP `buscar_vagas`. O endpoint responde em SSE (uma única linha
// "data: {...}"), mesmo sendo, na prática, uma chamada request/response simples.
async function callBuscarVagas(query, pagina) {
  const body = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name: 'buscar_vagas', arguments: { query, itensPagina: ITEMS_PER_PAGE, pagina } }
  };
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} para "${query}"@${pagina}`);
  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data:'));
  if (!dataLine) throw new Error(`resposta sem "data:" para "${query}"@${pagina}: ${text.slice(0, 200)}`);
  const rpc = JSON.parse(dataLine.slice(5).trim());
  if (rpc.error) throw new Error(`MCP error para "${query}"@${pagina}: ${JSON.stringify(rpc.error)}`);
  const content = rpc.result && rpc.result.content && rpc.result.content[0];
  if (!content || typeof content.text !== 'string') throw new Error(`resposta inesperada para "${query}"@${pagina}`);
  return JSON.parse(content.text); // { sucesso, total, pagina, totalPaginas, vagas: [...] }
}

async function fetchAll(query) {
  const out = [];
  let pagina = 1, totalPaginas = 1;
  do {
    let payload;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { payload = await callBuscarVagas(query, pagina); break; }
      catch (e) { if (attempt === 2) throw e; await sleep(800); }
    }
    out.push(...(payload.vagas || []));
    totalPaginas = payload.totalPaginas || 1;
    pagina++;
    await sleep(150);
  } while (pagina <= Math.min(totalPaginas, MAX_PAGES));
  return out;
}

(async () => {
  const companies = loadCompanies();
  const matchCompany = buildCompanyMatcher(companies);

  const byId = new Map();
  for (const q of QUERIES) {
    process.stdout.write(`  [empregare] "${q}" ... `);
    const vagas = await fetchAll(q);
    for (const v of vagas) byId.set(v.id, v);
    console.log(`fetched=${vagas.length}`);
  }
  console.log(`[empregare] unique jobs pooled: ${byId.size}`);

  const results = [];
  let roleCount = 0, entryOkCount = 0, locOkCount = 0, inList = 0, outList = 0;
  for (const v of byId.values()) {
    const role = matchRole(v.cargo);
    if (!role) continue;
    roleCount++;
    if (!role.startsWith('Trainee') && !isEntryLevel(v.cargo)) continue;
    entryOkCount++;
    const location = (v.cidades || []).join('; ');
    if (!isAllowedLocation(v.remoto, location)) continue;
    locOkCount++;
    const company = matchCompany(v.empresa);
    if (company) inList++; else outList++;
    results.push({
      platform: 'Empregare',
      companyList: company || v.empresa, // fora da lista: usa o nome da empresa como rótulo
      companyEmpregare: v.empresa,
      na_lista: company ? 'Sim' : 'Não',
      role,
      jobTitle: v.cargo,
      workplaceType: v.remoto,
      location,
      url: v.urlCandidatura,
      publishedDate: '',
      deadline: '' // a tool buscar_vagas nao expoe data de publicacao nem prazo final
    });
  }
  console.log(`[empregare] role-matched=${roleCount} nivel-entry-ok=${entryOkCount} local-ok(remoto/Brasília-DF)=${locOkCount} -> rows=${results.length} (in-list=${inList}, fora-da-lista=${outList})`);
  fs.writeFileSync(path.join(DIR, 'empregare_results.json'), JSON.stringify(results, null, 2));
  console.log(`[empregare] wrote ${results.length} rows -> empregare_results.json`);
})();
