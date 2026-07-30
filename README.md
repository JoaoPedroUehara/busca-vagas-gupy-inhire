# Busca de vagas — Gupy + InHire + Empregare + Cia de Talentos + Eureca

Pipeline que descobre vagas em **Mercado Financeiro, Análise de Dados/BI/Growth e Programas
Trainee** (para prováveis formandos) em cinco fontes do mercado brasileiro, e entrega uma
planilha Excel pronta para candidatura. Aceita vaga **100% remota OU presencial/híbrida em
Brasília-DF**, sempre de **nível inicial** (Assistente, Auxiliar, Analista Júnior ou, no
máximo, Analista I — além de Trainee/Estágio).

A sacada: as cinco plataformas expõem **APIs JSON públicas**, cada uma de um jeito diferente:

| Fonte | Como entra |
|---|---|
| **Gupy** | Busca global via API REST |
| **Empregare** | Tool **MCP** (`buscar_vagas`) — a única que expõe MCP |
| **InHire** | **Não tem busca global**: cada empresa é um *tenant* isolado e não há lista pública de clientes. O pipeline reconstrói a lista colhendo subdomínios reais da web aberta (Wayback CDX, urlscan, Common Crawl) e validando cada slug na API — o que faz aparecer vaga que não está em nenhum agregador |
| **Cia de Talentos** | API REST do próprio SPA de candidatos (achada no bundle AngularJS) |
| **Eureca** | API pública do app de candidatos (achada no bundle Vite) — a única fonte nova com **prazo final** de inscrição |

## Como rodar

```powershell
powershell -ExecutionPolicy Bypass -File busca_vagas\rodar_tudo.ps1
```

Requer **Node.js** no PATH e **Excel** instalado (a planilha é gerada via automação COM).
Feche o `vagas_gupy_inhire.xlsx` antes de rodar.

Documentação completa — arquitetura, os 13 passos do pipeline, os bugs de API descobertos e
como ajustar os filtros de cargo/local/senioridade: **[`busca_vagas/README.md`](busca_vagas/README.md)**.

> **Seja Trainee não entrou:** é um WordPress/blog sem dados estruturados de vaga (só matérias
> editoriais sobre programas). Detalhes em *Limitações honestas* na doc completa.

## Estrutura

| Caminho | O que é |
|---|---|
| `busca_vagas/*.js` | Coleta e validação (Gupy, InHire, Empregare, Cia de Talentos, Eureca, harvest de tenants, merge, dedup) |
| `busca_vagas/*.ps1` | Orquestração, extração da lista de empresas e build da planilha |
| `busca_vagas/agendado_run.ps1` | Wrapper da Tarefa Agendada do Windows (roda 11h30 e 18h) |
| `empresas.xlsx` | Lista de empresas-alvo (entrada) |
| `vagas_gupy_inhire.xlsx` | Planilha final, 3 abas (saída) — **não versionada**: carrega a coluna "Situação" com suas candidaturas. Gere a sua rodando o pipeline. |

## Nota

Usa apenas endpoints públicos e não autenticados, com pool de concorrência limitado — os mesmos
dados que qualquer visitante vê nas páginas de carreiras e nos portais de vaga. Nada de
credencial, login ou dado de candidato.
