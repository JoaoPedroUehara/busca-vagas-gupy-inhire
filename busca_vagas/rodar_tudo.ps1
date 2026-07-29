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

# Todas as fontes de uma vez. O tempo desta etapa e o do script mais lento, nao a soma.
#
# O gupy_presence_full.js voltou para dentro do bloco por causa do cache incremental: numa
# rodada quente ele faz ~130 requisicoes (so reconfere os slugs conhecidos) em vez de ~4400,
# entao nao disputa mais banda o suficiente para a gupy.io derrubar conexao. Foi por isso que
# ele precisou rodar sozinho antes do cache — sem ele, a aba Presenca vinha com 128 em vez de
# 130 porque o probe() registrava falha de rede como "empresa sem pagina".
# Se a contagem de empresas da aba Presenca comecar a oscilar para baixo de novo, o primeiro
# suspeito e este ponto: tire este script do array e rode-o como Step separado.
StepParalelo 2 "Coletar todas as fontes" @(
  'gupy.js',                # vagas Gupy (busca global)
  'gupy_presence_full.js',  # presenca por subdominio (incremental, via cache)
  'empregare.js',           # vagas Empregare (tool MCP)
  'ciadetalentos.js',       # programas trainee/estagio
  'eureca.js',              # programas trainee/estagio
  'inhire.js',              # tenants InHire chutados pela sua lista
  'harvest_inhire.js'       # slugs InHire da web aberta (Wayback/urlscan/CC)
)

Step 3 "InHire: validar todos os slugs na API"      { node "$dir\validate_inhire.js" }
Step 4 "InHire: gerar saidas (vagas + empresas)"    { node "$dir\inhire_saida.js" }
Step 5 "Consolidar e deduplicar -> vagas_final"     { node "$dir\merge.js" }
Step 6 "Carimbar data de deteccao (novas = hoje)"   { node "$dir\stamp_dates.js" }
Step 7 "Montar tabela de presenca"                  { node "$dir\presence.js" }
Step 8 "Gerar planilha final (Excel, 3 abas)"       { & "$dir\build_xlsx.ps1" }

$mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
Write-Host ""
Write-Host "==== TEMPO POR ETAPA ====" -ForegroundColor Cyan
$script:tempos.GetEnumerator() | ForEach-Object {
  Write-Host ("  {0,6}s  {1}" -f $_.Value, $_.Key)
}
Write-Host ""
Write-Host "==== CONCLUIDO em $mins min ====" -ForegroundColor Green
Write-Host "Planilha: ..\vagas_gupy_inhire.xlsx" -ForegroundColor Green
