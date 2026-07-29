# Busca de vagas — Gupy + InHire + Empregare + Cia de Talentos + Eureca

Pipeline que encontra vagas em **Mercado Financeiro, Análise de Dados/BI/Growth e Programas
Trainee** (para prováveis formandos) nas cinco plataformas, e gera uma planilha Excel pronta
para candidatura. Escopo de local: **100% remoto OU presencial/híbrido em Brasília-DF**.
Escopo de senioridade: **nível inicial, sem exceção** — Assistente, Auxiliar, Analista
Júnior/Jr, ou no máximo Analista I (mais Trainee, que é entry-level por definição); Pleno,
Sênior, Especialista, Coordenador em diante ficam de fora. A busca é **global** (todas as
empresas com vaga aberta no cargo-alvo); a sua lista de empresas serve para **marcar** o que é
dela (coluna "Na sua lista?") e montar a aba de Presença — não corta mais as de fora.

Última execução: **29/07/2026** → **45 vagas de nível inicial** (8 Gupy + 5 InHire + 10
Empregare + 9 Cia de Talentos + 13 Eureca) · 251 empresas mapeadas por presença (Gupy=130,
InHire=166) · 299 empresas InHire fora da lista. Roda em ~5-6 min.

> **Duas famílias de fonte, com regras diferentes.** Gupy/InHire/Empregare listam **vagas**
> (cargo + local concretos) → filtro estrito de cargo, local e senioridade. Cia de Talentos e
> Eureca listam **programas** de Trainee/Estágio, onde o "título" é o nome do programa
> ("Programa de Trainee GEQ 2026") e a praça costuma não ser declarada → regras próprias
> (ver *Agregadores de programa* abaixo). Programa sem área/local declarado entra **com alerta**
> em vez de ser descartado.

---

## Como rodar de novo (o jeito rápido)

1. (Opcional) Atualize a lista de empresas em
   `..\empresas.xlsx` — uma empresa por linha, na primeira coluna.
2. Abra o **PowerShell** nesta pasta e rode:

   ```powershell
   powershell -ExecutionPolicy Bypass -File rodar_tudo.ps1
   ```

3. Ao final, abra a planilha gerada: **`..\vagas_gupy_inhire.xlsx`**

O processo leva ~3–10 min (a maior parte é rede: buscar e validar tenants InHire).

> ⚠️ **FECHE o `vagas_gupy_inhire.xlsx` no Excel antes de rodar.** Se estiver aberto, o
> arquivo fica travado e a última etapa falha. O `build_xlsx.ps1` agora avisa cedo se
> detectar o lock (`~$vagas_gupy_inhire.xlsx`) em vez de deixar um Excel órfão pendurado.

### Pré-requisitos
- **Node.js** (testado no v24) no PATH — https://nodejs.org
- **Microsoft Excel** instalado (a planilha é gerada via automação COM do Excel)
- Conexão à internet

---

## O que sai (a planilha, 3 abas)

| Aba | Conteúdo |
|-----|----------|
| **Vagas** | Vagas nos cargos-alvo (das CINCO plataformas) que são 100% remotas OU presenciais/híbridas em Brasília-DF, e de nível inicial (Assistente/Auxiliar/Júnior/no máximo Analista I, ou Trainee/Estágio). Coluna **"Na sua lista?"** separa o que é da sua lista (Sim) do que foi descoberto fora dela (Não) — vale para as três fontes. Coluna **Alerta** sinaliza título com "híbrido/presencial" ou local fora do BR (pode exigir inglês). Coluna **"Detectada em"** = data em que a vaga apareceu pela 1ª vez no pipeline (filtre pela data de hoje para ver o que é novo). Link clicável para candidatar. |
| **Presença por Empresa** | Quais empresas da sua lista têm página na Gupy e/ou InHire, com links de carreiras. (Empregare é um board de vagas de terceiros, não um ATS por empresa, então não entra nesta aba — só na aba Vagas.) |
| **InHire novas (fora da lista)** | Empresas InHire com vaga aberta que **não** estão na sua lista, ordenadas por volume. Mapa para explorar além dos seus cargos. |

---

## Como o pipeline funciona (e o que descobri)

Gupy e InHire são ATS (cada empresa tem sua própria página de carreiras); a Empregare é um job
board de vagas de terceiros com busca própria. Não existe lista pública de clientes da Gupy/InHire.
A sacada foi usar as **APIs públicas** direto (curl/fetch), não scraping de página — WebFetch dá
403/SPA, mas as APIs JSON respondem.

### Gupy — tem busca global
- API: `GET https://employability-portal.gupy.io/api/v1/jobs?jobName=<cargo>&offset=<n>&limit=100`
- Campos: `careerPageName` (empresa), `name` (título), `workplaceType` (`remote`/`hybrid`/`on-site`), `jobUrl`.
- **Cuidado:** `pagination.total` é bugado (trava em 100 quando `limit>=100`). Pagino por offset até uma página vir com menos de 100 linhas. `limit=1000` é rejeitado.
- Presença real por empresa: `https://<slug>.gupy.io/` → 200 + `<title>Empresa</title>` se existe; 404 se não.

### InHire — NÃO tem busca global (é por empresa/"tenant")
- API: `GET https://api.inhire.app/job-posts/public/pages` com header `X-Tenant: <slug>`.
  - Tenant real → objeto `{tenantName, jobsPage:[{displayName, workplaceType (Remote/Hybrid/On-site), location, jobId, status}]}`
  - Tenant inexistente → `[]`. (É o "oráculo" que confirma se a empresa usa InHire.)
- Página pública da vaga: **`https://<slug>.inhire.app/vagas/<jobId>/<slug-do-titulo>`** (o `.com.br` NÃO resolve). **O segmento do slug do título é obrigatório:** a rota do SPA é `/vagas/:jobId/:slug`; sem o `:slug` a página fica TELA PRETA (o servidor sempre devolve 200 com a mesma casca — o roteamento é client-side). O slug é cosmético (a vaga carrega pelo `jobId`), então `slugify(displayName)` resolve — a API não expõe o slug real.
- **Achar todos os tenants:** Certificate Transparency e passive DNS **não** funcionam (wildcard
  `*.inhire.app`). O que funciona é colher slugs reais da web aberta e validar cada um na API:
  - **Wayback Machine (CDX)** — maior rendimento (~400 hosts)
  - **urlscan.io** (`domain:inhire.app`, paginado)
  - **Common Crawl** (vários índices)

### Casamento empresa ↔ tenant/careerPage
Normaliza acento/caixa e exige **token distintivo** (ignora genéricos: consultoria, saúde,
educação, tech, grupo…) ou compact-substring forte. Sem isso dá falso positivo
(ex.: "Lopes Consultoria" ↔ "BIX Consultoria de Dados").

### Empregare — MCP tool, sem harvest de tenant
- Endpoint: `POST https://www.empregare.com/api/mcp` (protocolo MCP/JSON-RPC sobre HTTP,
  resposta em SSE — uma única linha `data: {...}` mesmo numa chamada request/response simples).
- Tool: `buscar_vagas({ query, localidade, pcd, pagina, itensPagina })`, não exige login.
  `itensPagina` vai até 50; a busca por texto (`query`) é frouxa/fuzzy — não trata como AND
  estrito, então o filtro de cargo/local é feito no nosso lado (`matchRole` + `isAllowedLocation`),
  igual às outras duas fontes.
- Campos por vaga: `cargo`, `empresa`, `remoto` (`"Totalmente Remoto"` / `"Presencial"` /
  `"Híbrido"`), `cidades` (array `"Cidade, UF, BR"`), `urlCandidatura`. Não expõe descrição da
  vaga — ver nota sobre Trainee em **Limitações honestas**.

### Cia de Talentos — API REST do próprio SPA de candidatos
- `POST https://vagas.ciadetalentos.com.br/applicant/rest/applicant/authentication/filter`
  com body `{"locale":"pt"}` → array de oportunidades. Sem login (o endpoint fica sob
  `/authentication/` mas é o que o portal público consome antes de logar).
- Achado partindo do SPA AngularJS em `vagas.ciadetalentos.com.br/applicant/`: o controller
  chama `ApplicantAuthentication.filter(...)`, e o `applicant-services-*.js` mapeia esse
  método para a URL acima.
- Campos: `opportunityName` (nome do programa), `companyName`, `hiringType`
  (`Trainee` / `Estágio Superior` / `Estágio Técnico` / `Ensino Médio`), `opportunityAreas`,
  `opportunityLocations`, `opportunityInscriptionUrl`.
- **Não tem prazo final utilizável:** `inscriptionEnd` vem `null` e `daysForInscription` vem `0`
  ("Encerra hoje") em *todas* as linhas, contradizendo `countFinishDays`. Como não dá para
  derivar data confiável, a coluna Prazo Final fica vazia de propósito — melhor vazio do que
  uma data errada.

### Eureca — API pública do app de candidatos
- `GET https://candidate-api.eureca.me/opportunities?page=1&pageSize=200` →
  `{items, total, page, pageSize}`. `pageSize=200` traz tudo numa requisição.
- Base descoberta no bundle Vite de `app.eureca.me` (`apiUrl` → `candidate-api.eureca.me`).
  A raiz e a maioria dos paths exigem token (401), mas `/opportunities` é aberto.
- O parâmetro `contractTypeKey` na query é **ignorado** pelo servidor (devolve tudo) → o filtro
  de tipo é feito no nosso lado.
- Campos: `name` (área/posição), `programName`, `companyName`, `contractTypeKey`
  (`trainee`/`internship`/`young-apprentice`), `workModels`, `locations{states,cities}`,
  `endApplying`. **É a única fonte nova com prazo final absoluto** (`endApplying`, ISO).

---

## Ordem dos scripts (o que o rodar_tudo.ps1 chama)

| # | Script | Entrada → Saída |
|---|--------|-----------------|
| 1 | `extrair_empresas.ps1` | `empresas.xlsx` → `companies.json` |
| 2 | `gupy_presence_full.js` | companies.json + `gupy_presence_cache.json` → `gupy_presence_full.json` (roda **sozinho** — ver abaixo) |
| 3 | **↓ os 6 em paralelo ↓** | |
| | `gupy.js` | companies.json → `gupy_results.json`, `gupy_presence.json` |
| | `empregare.js` | companies.json → `empregare_results.json` (tool MCP `buscar_vagas`) |
| | `ciadetalentos.js` | companies.json → `ciadetalentos_results.json` (programas trainee/estágio) |
| | `eureca.js` | companies.json → `eureca_results.json` (programas trainee/estágio, com prazo) |
| | `inhire.js` | companies.json → `inhire_tenants.json` (chute de slug pela lista) |
| | `harvest_inhire.js` | web → `wb_app.txt`, `us_app_paged.json`, `cc_app.jsonl` |
| 4 | `validate_inhire.js` | slugs → `inhire_all_tenants.json`, `inhire_all_vagas.json` |
| 5 | `inhire_saida.js` | → `inhire_results.json`, `inhire_new_companies.json` |
| 6 | `merge.js` | as 5 fontes → `vagas_final.json` (dedup) |
| 7 | `stamp_dates.js` | mantém `seen.json` (data da 1ª aparição) → grava `detectado_em` em cada vaga |
| 8 | `presence.js` | → `presence_combined.json` |
| 9 | `build_xlsx.ps1` | tudo → `..\vagas_gupy_inhire.xlsx` |

O `rodar_tudo.ps1` imprime o **tempo de cada etapa** no fim (e de cada script dentro da etapa
paralela), então dá para ver na hora quem virou gargalo.

### Por que a ordem é essa (e o que NÃO paralelizar)

O `rodar_tudo.ps1` roda os coletores de fonte **em paralelo** (Start-Job), porque eles não
dependem uns dos outros: leem `companies.json` e escrevem arquivos distintos. O tempo da etapa
passa a ser o do script mais lento, não a soma. Só o encadeamento da InHire
(descoberta → validação → saída) e a consolidação final são sequenciais, porque cada passo
consome o arquivo do anterior.

Duas exceções aprendidas na marra, ambas com a **gupy.io**:

- **`gupy_presence_full.js` roda sozinho, fora do bloco paralelo.** São centenas de requisições
  a `<slug>.gupy.io`; disputando banda com os outros coletores, a Gupy derruba conexão e o
  `probe()` registra a falha como "empresa sem página" — a aba Presença veio com 128 empresas
  em vez de 130. Sozinho, o resultado é estável.
- **Não aumente a concorrência desse pool.** Testado em 32: não ficou mais rápido (52s vs 51s)
  e ainda achou **menos** empresas (125 vs 130), pelo mesmo motivo. 16 é o ponto de equilíbrio.
  No `inhire.js` o mesmo aumento (16 → 28) foi seguro e cortou o tempo pela metade — a API da
  InHire aguenta; a da Gupy não.

Moral: neste pipeline, mais concorrência contra o mesmo host degrada os dados **em silêncio**,
porque um `catch` que devolve "não achei" é indistinguível de "não existe". Ao mexer aqui,
compare sempre a contagem de empresas/tenants com a rodada anterior, não só o cronômetro.

### Cache incremental da presença Gupy

`gupy_presence_full.js` mantém `gupy_presence_cache.json` para não revarrer as 737 empresas a
cada rodada — era o passo mais caro do pipeline (~60s):

- **Encontrada:** reconfere só o slug já conhecido (1 requisição em vez de até 7). Se cair,
  faz varredura completa — a empresa pode ter trocado de slug, não necessariamente saído da Gupy.
- **Não encontrada:** vale por `TTL_DIAS` (7). Empresa entra em ATS raramente, e é esse grupo
  (a maioria da lista) que custa 7 requisições cada.
- **Falha de rede ≠ ausência:** o `probe()` separa `ausente` (a Gupy respondeu que não existe)
  de `incerto` (rede caiu, 429, 5xx). Só `ausente` vira negativo no cache. Sem essa distinção,
  um blip de rede sumiria com a empresa da planilha até o TTL vencer.

Efeito: **rodada fria ~154s, rodada quente ~13s.** Para forçar varredura completa, apague o
`gupy_presence_cache.json`.

`lib.js` = helpers compartilhados (normalização, `matchRole` de cargo, `isAllowedLocation`/`isBrasiliaDF` de local, `isEntryLevel` de senioridade, `buildCompanyMatcher` de empresa, `slugify` do título da vaga, pool de concorrência).
`seen.json` = histórico persistente `{ chave → data }` da 1ª vez que cada vaga foi vista (não apagar; é o que alimenta a coluna "Detectada em").

---

## Ajustar filtros (o que mexer)

- **Cargos aceitos:** função `matchRole()` em `lib.js`. Duas categorias novas:
  - `FINANCE_RE` → bucket **"Mercado Financeiro"** (financeiro, investimentos, tesouraria,
    risco, crédito, controladoria, FP&A, asset/wealth management...). Regex amplo de propósito
    (área, não nível) — quem corta por senioridade é o `isEntryLevel()` logo abaixo.
  - Bloco ` trainee ` no topo da função → bucket **"Trainee — Mercado Financeiro"** ou
    **"Trainee — Dados/Analytics"** (usa `DATA_LOOSE_RE`, mais frouxo que os checks de dados
    abaixo). Trainee de área não relacionada (industrial, mecânica, agro...) retorna `null`.
  - Para incluir outros cargos (ex.: Product Analyst, Analytics Engineer, Pricing, CRM),
    adicione padrões na cadeia de `has(...)` existente.
- **Termos de busca (ampliam o pool antes do filtro local):** array `QUERIES` no topo de
  `gupy.js` e de `empregare.js` — cada termo é uma chamada de busca separada; o filtro real de
  cargo é sempre o `matchRole()`.
- **Local aceito — 100% remoto OU presencial/híbrido em Brasília-DF:** função
  `isAllowedLocation()` em `lib.js`, usada em `gupy.js`, `inhire.js` e `validate_inhire.js` (a
  Gupy usa `city`/`state`/`country`; InHire e Empregare usam o campo de local livre da API).
  Para voltar a "só remoto", troque a chamada por `isRemote(workplaceType)`. Para aceitar outra
  cidade além de Brasília, edite `isBrasiliaDF()`.
- **Nível de senioridade aceito — nível inicial, sem exceção:** função `isEntryLevel()` em
  `lib.js`, aplicada logo após o `matchRole()` em `gupy.js`, `inhire.js`, `validate_inhire.js` e
  `empregare.js` (Trainee não passa por essa checagem — já é entry-level por natureza). É uma
  **lista branca**, não uma lista negra: só entra se o título tiver `assistente`, `auxiliar`,
  `júnior`/`jr`, ou um "I" solto (o teto, ex.: "Analista Financeiro I"); qualquer marcador de
  nível acima disso (`SENIOR_RE`: pleno, sênior, especialista, coordenador, supervisor,
  gerente, diretor, head, lead, II, III, IV...) exclui a vaga mesmo que ela também bata um dos
  padrões de entry-level (evita passar, por ex., "Analista Sênior - Regional I"). Um "Analista
  Financeiro" sem nenhum qualificador **não entra** — na dúvida, fica de fora. Para afrouxar,
  edite `ENTRY_RE`/`SENIOR_RE`.
- **Agregadores de programa (Cia de Talentos, Eureca) — regras próprias:** nessas duas fontes o
  título é o nome do programa, não um cargo, então `matchRole()`/`isEntryLevel()` não se aplicam
  (Trainee e Estágio já são entry-level por definição). Em `lib.js`:
  - `matchAreaLoose()` — casamento **de área**, mais frouxo que `matchRole`: pega "Finanças",
    "Dados e Analytics", "Tecnologia & Dados". Devolve `Mercado Financeiro` ou `Dados / Analytics`.
  - `namesSpecificArea()` — decide o caso "sem match de área": se o título **nomeia uma área
    específica** que não é Financeiro/Dados (ex.: "Trainee em Vendas", "Estágio em Projetos
    Submarinos"), a linha é cortada; se é um programa **generalista** que não nomeia área nenhuma
    (ex.: "Programa de Trainee GEQ 2026"), entra como "Área a confirmar" **com alerta**. Funciona
    removendo do título o esqueleto do nome (programa/trainee/estágio/ano/edição), o nome da
    empresa, siglas curtas (GEQ, PwC) e marcadores vazios ("Diversas", "Geral") — se sobrar
    palavra, é área específica.
  - **Localidade:** esses programas quase nunca declaram praça. Local declarado só passa se for
    remoto ou Brasília-DF (igual às outras fontes); local **não declarado** entra com alerta em
    vez de ser descartado — programa nacional costuma incluir Brasília.
- **Escopo (Gupy, InHire e Empregare = tudo, marcado):** as três fontes são **simétricas** —
  não filtram mais por lista; trazem TODAS as vagas que batem cargo+local e marcam `na_lista`
  (Sim/Não). O `matchCompany`/`buildCompanyMatcher` só serve para rotular isso (e, no caso da
  Gupy, montar a aba **Presença**). Para voltar ao escopo "só minha lista", filtre
  `na_lista === 'Sim'`.

---

## Limitações honestas
- A descoberta InHire é **um piso, não um teto**: só acha tenants que já apareceram na web
  aberta ou que dão match de slug pela lista. Empresas com domínio de carreira próprio
  (custom domain) podem não aparecer.
- `workplaceType` às vezes vem mistagueado (título diz "híbrido" mas API diz remoto) → coluna Alerta.
- Local fora do BR pode exigir inglês → coluna Alerta.
- Os índices do Common Crawl e o cache do urlscan mudam com o tempo; o `harvest_inhire.js`
  pega os índices mais recentes dinamicamente.
- **Trainee e "aceita prováveis formandos":** nenhuma das três APIs devolve a descrição completa
  da vaga na busca (só cargo/empresa/local/link), então o pipeline não consegue confirmar pelo
  título se um programa Trainee aceita formatura em uma data específica (ex.: 1º semestre de
  2027) — isso normalmente só está no corpo do anúncio. Todo Trainee de Financeiro/Dados
  encontrado entra na planilha; **confira a janela de formatura aceita no link antes de
  aplicar.**
- **Empregare — `query` é busca frouxa:** a tool `buscar_vagas` não faz match exato por palavra
  (ex.: buscar "analista de dados" já trouxe "Analista de Defesa Cibernética"), então o
  `empregare.js` busca por vários termos e deixa o corte de cargo/local por nossa conta
  (`matchRole` + `isAllowedLocation`), igual às outras fontes.
- **Prazo final só sai de 2 das 5 fontes:** Gupy (`applicationDeadline`) e Eureca
  (`endApplying`). InHire e Empregare não expõem o campo; a Cia de Talentos expõe campos
  relativos contraditórios (ver acima). Nessas três a coluna fica vazia.
- **Seja Trainee ficou de fora — não tem dado estruturado.** É um WordPress + WooCommerce
  (blog + venda de cursos): os post types são `post`, `page`, `product`, `podcast` — **não há
  post type de vaga**. Os 655 posts da categoria "Trainee" são matérias editoriais
  ("Trainee ADM tem 18 meses, rotação por 12 áreas..."), sem campo de empresa, local, prazo ou
  link de inscrição. Dá para ler os títulos via `wp-json/wp/v2/posts`, mas isso viraria manchete
  de notícia na planilha, não vaga — por isso não foi integrado. Vale como leitura de
  acompanhamento no site.

## Rodar um script isolado
Da pasta, ex.: `node gupy.js` ou `powershell -File build_xlsx.ps1`.
