// Eureca — agregador de PROGRAMAS (Trainee / Estagio / Jovem Aprendiz).
// API publica (sem login) usada pelo app de candidatos:
//   GET https://candidate-api.eureca.me/opportunities?page=1&pageSize=200
//   -> { items:[...], total, page, pageSize }
// E a unica das fontes novas que devolve PRAZO FINAL absoluto (`endApplying`, ISO).
// Como nos outros agregadores de programa, o titulo e a area do programa ("Trainee em
// Financas") e a localidade costuma vir vazia -> corte de area por exclusao e local
// indefinido entra com alerta.
const fs = require('fs');
const path = require('path');
const { DIR, loadCompanies, matchAreaLoose, namesSpecificArea, isBrasiliaDF, buildCompanyMatcher } = require('./lib.js');

const API = 'https://candidate-api.eureca.me/opportunities';
const PAGE_SIZE = 200;
const MAX_PAGES = 10; // safety cap

// Jovem aprendiz exige estar no ensino medio/tecnico -> fora do alvo (graduacao).
const CONTRACT_TYPES_OK = new Set(['trainee', 'internship']);
const CONTRACT_LABEL = { trainee: 'Trainee', internship: 'Estágio' };

async function fetchPage(page) {
  const res = await fetch(`${API}?page=${page}&pageSize=${PAGE_SIZE}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} na API da Eureca (page ${page})`);
  return res.json();
}

async function fetchAll() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await fetchPage(page);
    const items = json.items || [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break; // ultima pagina
  }
  return out;
}

// Junta tudo que a API sabe sobre onde o programa acontece.
function locationText(o) {
  const loc = o.locations || {};
  return [
    ...(loc.cities || []), ...(loc.states || []),
    o.cityName, o.stateAcronym
  ].filter(Boolean).join(', ');
}

(async () => {
  const companies = loadCompanies();
  const matchCompany = buildCompanyMatcher(companies);

  const all = await fetchAll();
  console.log(`[eureca] oportunidades no portal: ${all.length}`);

  const results = [];
  let tipoOk = 0, areaOk = 0, locOk = 0, inList = 0, outList = 0;
  for (const o of all) {
    if (!CONTRACT_TYPES_OK.has(o.contractTypeKey)) continue;
    tipoOk++;

    const titulo = o.name || o.programName || '';
    const area = matchAreaLoose(titulo) || matchAreaLoose(o.programName || '');
    // Sem match de area: so entra se o programa for generalista (nao nomeia area nenhuma).
    // Se nomeia uma area especifica que nao e Financeiro/Dados, fica de fora.
    if (!area && namesSpecificArea(titulo, o.companyName)) continue;
    areaOk++;

    // Trainee/Estagio ja sao entry-level por definicao -> nao passa por isEntryLevel().
    const label = CONTRACT_LABEL[o.contractTypeKey];
    const role = area ? `${label} — ${area}` : `${label} — Área a confirmar`;

    const local = locationText(o);
    const workModels = (o.workModels || []).join('/');
    const remoto = /remot|home ?office/i.test(workModels);
    const localIndefinido = !local && !remoto;
    // Local definido: so passa se for remoto ou Brasilia-DF. Sem local declarado -> alerta.
    if (!localIndefinido && !remoto && !isBrasiliaDF(local)) continue;
    locOk++;

    const company = matchCompany(o.companyName);
    if (company) inList++; else outList++;

    results.push({
      platform: 'Eureca',
      companyList: company || o.companyName || '',
      companyEureca: o.companyName || '',
      na_lista: company ? 'Sim' : 'Não',
      role,
      jobTitle: o.programName && o.programName !== titulo ? `${titulo} — ${o.programName}` : titulo,
      workplaceType: workModels || label,
      location: local || 'Não informado',
      url: o.id ? `https://app.eureca.me/vagas/${o.id}` : '',
      publishedDate: o.publishedAt || o.createdAt || '',
      deadline: o.endApplying || '', // unica fonte nova com prazo final absoluto
      localIndefinido
    });
  }

  console.log(`[eureca] tipo-ok=${tipoOk} area-ok=${areaOk} local-ok=${locOk} -> rows=${results.length} (in-list=${inList}, fora-da-lista=${outList})`);
  fs.writeFileSync(path.join(DIR, 'eureca_results.json'), JSON.stringify(results, null, 2));
  console.log(`[eureca] wrote ${results.length} rows -> eureca_results.json`);
})();
