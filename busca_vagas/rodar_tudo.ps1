# =====================================================================
# Pipeline completo de busca de vagas
#   Gupy + InHire + Empregare + Cia de Talentos + Eureca
# Uso:  powershell -ExecutionPolicy Bypass -File rodar_tudo.ps1
# (opcional) atualize antes o arquivo empresas.xlsx com sua lista.
#
# Os coletores de fonte nao dependem uns dos outros (leem companies.json,
# escrevem arquivos distintos) -> rodam em PARALELO. So o encadeamento da
# InHire (descoberta -> validacao -> saida) e a consolidacao final sao
# sequenciais, porque cada passo consome o arquivo do anterior.
# =====================================================================
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
Set-Location $dir

$script:tempos = [ordered]@{}

function Step($n, $desc, $cmd) {
  Write-Host ""
  Write-Host "==== [$n] $desc ====" -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # Reset: passos em .ps1/COM (Excel) nao setam $LASTEXITCODE; sem isso o $null
  # herdado dispara falso "falhou". Assim so quebra quando um node retorna != 0.
  $global:LASTEXITCODE = 0
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "Falhou na etapa: $desc (exit $LASTEXITCODE)" }
  $sw.Stop()
  $script:tempos["[$n] $desc"] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
}

# Roda varios scripts node ao mesmo tempo. Cada job devolve a saida e o exit code;
# se qualquer um falhar, o pipeline para (mas so depois de todos terminarem, para
# a mensagem de erro sair junto com o log completo de quem rodou).
function StepParalelo($n, $desc, $scripts) {
  Write-Host ""
  Write-Host "==== [$n] $desc (em paralelo: $($scripts -join ', ')) ====" -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()

  $jobs = foreach ($s in $scripts) {
    Start-Job -Name $s -ScriptBlock {
      param($d, $f)
      $t = [Diagnostics.Stopwatch]::StartNew()
      $saida = & node (Join-Path $d $f) 2>&1 | Out-String
      $t.Stop()
      [PSCustomObject]@{
        Script = $f
        Exit   = $LASTEXITCODE
        Seg    = [math]::Round($t.Elapsed.TotalSeconds, 1)
        Saida  = $saida
      }
    } -ArgumentList $dir, $s
  }

  $jobs | Wait-Job | Out-Null
  $falhas = @()
  foreach ($j in $jobs) {
    $r = Receive-Job -Job $j
    if ($r -and $r.Saida) { Write-Host $r.Saida.TrimEnd() }
    if (-not $r -or $r.Exit -ne 0) {
      $falhas += "$($j.Name) (exit $(if ($r) { $r.Exit } else { 'sem retorno' }))"
    } else {
      Write-Host ("  -> {0}: {1}s" -f $r.Script, $r.Seg) -ForegroundColor DarkGray
    }
  }
  $jobs | Remove-Job -Force

  $sw.Stop()
  $script:tempos["[$n] $desc"] = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  if ($falhas.Count -gt 0) { throw "Falhou na etapa: $desc -> $($falhas -join '; ')" }
}

# Verifica Node
try { $null = (Get-Command node -ErrorAction Stop) } catch { throw "Node.js nao encontrado no PATH. Instale o Node (https://nodejs.org)." }

$t0 = Get-Date

Step 1 "Extrair empresas do xlsx -> companies.json" { & "$dir\extrair_empresas.ps1" }

# Roda SOZINHO, fora do bloco paralelo, de proposito: sao centenas de requisicoes a
# <slug>.gupy.io e, disputando banda com os outros coletores, a gupy.io derruba conexao
# — o probe() registra a falha como "empresa sem pagina" e a aba Presenca vem incompleta
# (medido: 128 em vez de 130). Sozinho, o resultado e estavel. Com o cache incremental
# este passo so custa caro na 1a rodada.
Step 2 "Gupy: presenca por subdominio (incremental)" { node "$dir\gupy_presence_full.js" }

# As demais fontes batem em hosts diferentes entre si -> sem disputa. O tempo desta
# etapa e o do script mais lento, nao a soma deles.
StepParalelo 3 "Coletar todas as fontes" @(
  'gupy.js',                # vagas Gupy (busca global)
  'empregare.js',           # vagas Empregare (tool MCP)
  'ciadetalentos.js',       # programas trainee/estagio
  'eureca.js',              # programas trainee/estagio
  'inhire.js',              # tenants InHire chutados pela sua lista
  'harvest_inhire.js'       # slugs InHire da web aberta (Wayback/urlscan/CC)
)

Step 4 "InHire: validar todos os slugs na API"      { node "$dir\validate_inhire.js" }
Step 5 "InHire: gerar saidas (vagas + empresas)"    { node "$dir\inhire_saida.js" }
Step 6 "Consolidar e deduplicar -> vagas_final"     { node "$dir\merge.js" }
Step 7 "Carimbar data de deteccao (novas = hoje)"   { node "$dir\stamp_dates.js" }
Step 8 "Montar tabela de presenca"                  { node "$dir\presence.js" }
Step 9 "Gerar planilha final (Excel, 3 abas)"       { & "$dir\build_xlsx.ps1" }

$mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
Write-Host ""
Write-Host "==== TEMPO POR ETAPA ====" -ForegroundColor Cyan
$script:tempos.GetEnumerator() | ForEach-Object {
  Write-Host ("  {0,6}s  {1}" -f $_.Value, $_.Key)
}
Write-Host ""
Write-Host "==== CONCLUIDO em $mins min ====" -ForegroundColor Green
Write-Host "Planilha: ..\vagas_gupy_inhire.xlsx" -ForegroundColor Green
