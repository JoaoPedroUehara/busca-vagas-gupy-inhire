// Cia de Talentos — agregador de PROGRAMAS (Trainee / Estagio), nao de vagas avulsas.
// API publica (sem login) usada pelo proprio SPA de candidatos:
//   POST /applicant/rest/applicant/authentication/filter  -> array de oportunidades
// Diferenca importante para Gupy/InHire/Empregare: aqui o titulo e o NOME DO PROGRAMA
// ("Programa de Trainee <Empresa> 2026"), que quase nunca diz a area, e a localidade
// costuma vir como "Localidade: Diversas". Por isso o corte de area e por EXCLUSAO
// (isOffTopicArea) e a localidade indefinida entra com alerta em vez de ser descartada.
const fs = require('fs');
const path = require('path');
const { DIR, loadCompanies, matchAreaLoose, namesSpecificArea, isAllowedLocation, isLocationUnspecified, buildCompanyMatcher } = require('./lib.js');

const API = 'https://vagas.ciadetalentos.com.br/applicant/rest/applicant/authentication/filter';

// So programas de nivel inicial. "Ensino Medio" fica de fora (o usuario esta em graduacao).
const HIRING_TYPES_OK = new Set(['Trainee', 'Estágio Superior']);

async function fetchOpportunities() {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ locale: 'pt' })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} na API da Cia de Talentos`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('resposta inesperada (esperava array)');
  return json;
}

(async () => {
  const companies = loadCompanies();
  const matchCompany = buildCompanyMatcher(companies);

  const all = await fetchOpportunities();
  console.log(`[ciadetalentos] oportunidades no portal: ${all.length}`);

  const results = [];
  let tipoOk = 0, areaOk = 0, locOk = 0, inList = 0, outList = 0;
  for (const o of all) {
    if (!HIRING_TYPES_OK.has(o.hiringType)) continue;
    tipoOk++;

    const titulo = o.opportunityName || '';
    // A area vem em campo proprio, mas quase sempre e "Área: Diversas" -> junta com o titulo
    // so para o teste de area, sem poluir o titulo exibido na planilha.
    const areaTexto = `${titulo} ${(o.opportunityAreas || '').replace(/^Área:\s*/i, '')}`;
    const area = matchAreaLoose(areaTexto);
    // Sem match de area: so entra se o programa for generalista (nao nomeia area nenhuma).
    // Se nomeia uma area especifica que nao e Financeiro/Dados, fica de fora.
    if (!area && namesSpecificArea(areaTexto, o.companyName)) continue;
    areaOk++;

    // Trainee/Estagio ja sao entry-level por definicao -> nao passa por isEntryLevel().
    const isTrainee = o.hiringType === 'Trainee';
    const prefixo = isTrainee ? 'Trainee' : 'Estágio';
    const role = area ? `${prefixo} — ${area}` : `${prefixo} — Área a confirmar`;

    const local = (o.opportunityLocations || '').replace(/^Localidade:\s*/i, '').trim();
    const localIndefinido = isLocationUnspecified(local);
    if (!localIndefinido && !isAllowedLocation('', local)) continue; // local definido e fora do alvo
    locOk++;

    const company = matchCompany(o.companyName);
    if (company) inList++; else outList++;

    results.push({
      platform: 'Cia de Talentos',
      companyList: company || o.companyName || '',
      companyCia: o.companyName || '',
      na_lista: company ? 'Sim' : 'Não',
      role,
      jobTitle: titulo,
      workplaceType: o.hiringType || '',
      location: local || 'Diversas',
      url: o.opportunityInscriptionUrl || o.opportunityHotsiteUrl || '',
      publishedDate: '',
      // A API so devolve campos relativos e contraditorios (daysForInscription=0 em tudo,
      // inscriptionEnd=null) -> nao da pra derivar uma data confiavel. Fica vazio de proposito.
      deadline: '',
      localIndefinido
    });
  }

  console.log(`[ciadetalentos] tipo-ok=${tipoOk} area-ok=${areaOk} local-ok=${locOk} -> rows=${results.length} (in-list=${inList}, fora-da-lista=${outList})`);
  fs.writeFileSync(path.join(DIR, 'ciadetalentos_results.json'), JSON.stringify(results, null, 2));
  console.log(`[ciadetalentos] wrote ${results.length} rows -> ciadetalentos_results.json`);
})();
