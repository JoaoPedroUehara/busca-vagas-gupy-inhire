$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$outPath = Join-Path (Split-Path -Parent $dir) 'vagas_gupy_inhire.xlsx'

$vagas    = Get-Content "$dir\vagas_final.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$presenca = Get-Content "$dir\presence_combined.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$novas    = Get-Content "$dir\inhire_new_companies.json" -Raw -Encoding UTF8 | ConvertFrom-Json

$INV = [Globalization.CultureInfo]::InvariantCulture

# --- Coluna "Situacao": estado preenchido POR VOCE, precisa sobreviver as rodadas -----------
# A planilha e recriada do zero a cada rodada, entao o que voce marca aqui seria perdido.
# O fluxo e: le o que esta no .xlsx atual -> funde em situacao.json -> reescreve na planilha
# nova. O JSON e a fonte duravel (sobrevive ate a planilha ser apagada); o .xlsx e sempre a
# versao mais recente, porque e onde voce acabou de editar.
$SIT_FILE = Join-Path $dir 'situacao.json'
$SIT_OPCOES = @('Aplicada', 'Não Aplicada', 'Desenvolvendo currículo')
$SIT_PADRAO = 'Não Aplicada'

# Mesma identidade usada pelo stamp_dates.js: jobId da URL quando existe, senao empresa|titulo.
function Get-VagaKey($link, $empresa, $titulo) {
  $m = [regex]::Match([string]$link, '/vagas/([0-9a-f-]{36})', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  $n = { param($s) ([string]$s).Normalize([Text.NormalizationForm]::FormD) -replace '\p{Mn}','' -replace '[^a-zA-Z0-9]','' }
  return (& $n $empresa).ToLower() + '|' + (& $n $titulo).ToLower()
}

$situacao = @{}
if (Test-Path -LiteralPath $SIT_FILE) {
  try {
    (Get-Content $SIT_FILE -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties |
      ForEach-Object { $situacao[$_.Name] = [string]$_.Value }
  } catch { Write-Warning "situacao.json ilegivel, recomecando: $($_.Exception.Message)" }
}

function Write-Sheet($ws, $name, $headers, $props, $rows, $linkCols, $widths, $wrapCols, $dateCols) {
  $ws.Name = $name
  $nCols = $headers.Count
  $nRows = @($rows).Count

  # Escreve a aba inteira em UMA atribuicao de array (antes era celula por celula: ~3800
  # chamadas COM entre as 3 abas, o que fazia esta etapa levar dezenas de segundos).
  $buf = New-Object 'object[,]' ($nRows + 1), $nCols
  for ($c = 0; $c -lt $nCols; $c++) { $buf[0, $c] = $headers[$c] }

  $r = 1
  foreach ($row in $rows) {
    for ($c = 0; $c -lt $nCols; $c++) {
      $val = [string]$row.$($props[$c])
      if (-not $val) { continue }
      if ($dateCols -contains ($c + 1)) {
        # Data DE VERDADE (numero de serie do Excel), nao texto. Como texto o Excel ordenava
        # alfabeticamente -> 01/08 < 04/09 < 14/08, ou seja, ordenar por Prazo Final dava a
        # ordem errada. Nao da para gravar a string e deixar o Excel interpretar: o locale
        # desta maquina e M/d/yyyy, entao "14/07/2026" nem seria uma data valida.
        $dt = [datetime]::MinValue
        if ([datetime]::TryParseExact($val, 'dd/MM/yyyy', $INV, [Globalization.DateTimeStyles]::None, [ref]$dt)) {
          $buf[$r, $c] = $dt.ToOADate()
        } else {
          $buf[$r, $c] = $val   # fora do padrao: preserva o dado como texto
        }
      } else {
        $buf[$r, $c] = $val
      }
    }
    $r++
  }
  $ws.Range($ws.Cells.Item(1, 1), $ws.Cells.Item($nRows + 1, $nCols)).Value2 = $buf
  foreach ($dc in $dateCols) { $ws.Columns.Item($dc).NumberFormat = 'dd/mm/yyyy' }

  # Links: uma atribuicao de array por coluna, com formula HYPERLINK, em vez de um
  # Hyperlinks.Add por celula. A propriedade Formula do COM e sempre invariante (nome de
  # funcao em ingles e virgula como separador), independente do idioma do Excel.
  foreach ($lc in $linkCols) {
    $ci = [Array]::IndexOf([object[]]$props, $lc)
    if ($ci -lt 0) { continue }
    $col = New-Object 'object[,]' $nRows, 1
    $r = 0
    foreach ($row in $rows) {
      $u = [string]$row.$lc
      if ($u) { $col[$r, 0] = '=HYPERLINK("' + $u.Replace('"', '""') + '","Abrir")' }
      $r++
    }
    if ($nRows -gt 0) {
      $ws.Range($ws.Cells.Item(2, $ci + 1), $ws.Cells.Item($nRows + 1, $ci + 1)).Formula = $col
    }
  }

  $r = $nRows + 2
  $lastRow = [Math]::Max($r - 1, 1)
  $lastCol = $headers.Count
  $hdr = $ws.Range($ws.Cells.Item(1,1), $ws.Cells.Item(1,$lastCol))
  $hdr.Font.Bold = $true
  $hdr.Interior.Color = 8210719   # BGR teal
  $hdr.Font.Color = 16777215
  $hdr.HorizontalAlignment = -4108
  $ws.Rows.Item(1).RowHeight = 26
  if ($lastRow -ge 1) {
    $ws.Range($ws.Cells.Item(1,1), $ws.Cells.Item($lastRow,$lastCol)).AutoFilter() | Out-Null
  }
  $ws.Activate(); $excel.ActiveWindow.SplitRow = 1; $excel.ActiveWindow.FreezePanes = $true
  for ($c = 0; $c -lt $widths.Count; $c++) { $ws.Columns.Item($c+1).ColumnWidth = $widths[$c] }
  foreach ($wc in $wrapCols) { $ws.Columns.Item($wc).WrapText = $true }
}

# Aviso cedo se o arquivo de saida estiver aberto (lock do Excel) -> evita vazar processo COM.
$lockFile = Join-Path (Split-Path $outPath) ("~`$" + (Split-Path $outPath -Leaf))
if (Test-Path -LiteralPath $lockFile) {
  throw "O arquivo '$outPath' parece estar ABERTO no Excel (lock $lockFile). Feche-o e rode de novo."
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $null
try {
  # 1) Resgata o que voce marcou na planilha atual ANTES de sobrescreve-la.
  if (Test-Path -LiteralPath $outPath) {
    $old = $null
    try {
      $old = $excel.Workbooks.Open($outPath, $false, $true)   # somente leitura
      $ows = $old.Worksheets.Item(1)
      $usada = $ows.UsedRange
      $nc = $usada.Columns.Count
      # Acha as colunas pelo CABECALHO, nao pela posicao: assim continua funcionando se a
      # ordem das colunas mudar numa versao futura.
      $idx = @{}
      for ($c = 1; $c -le $nc; $c++) { $idx[[string]$ows.Cells.Item(1, $c).Text] = $c }
      $cSit = $idx['Situação']; $cEmp = $idx['Empresa']; $cTit = $idx['Titulo da Vaga']; $cLink = $idx['Link para Candidatura']
      if ($cSit -and $cEmp -and $cTit) {
        $resgatadas = 0
        for ($r = 2; $r -le $usada.Rows.Count; $r++) {
          $v = [string]$ows.Cells.Item($r, $cSit).Text
          if (-not $v -or $v -eq $SIT_PADRAO) { continue }   # so guarda o que voce mudou
          # O link e formula HYPERLINK -> tira a URL de dentro dela para montar a chave.
          $lk = ''
          if ($cLink) {
            $f = [string]$ows.Cells.Item($r, $cLink).Formula
            $mm = [regex]::Match($f, 'HYPERLINK\("([^"]+)"')
            if ($mm.Success) { $lk = $mm.Groups[1].Value } else { $lk = [string]$ows.Cells.Item($r, $cLink).Text }
          }
          $k = Get-VagaKey $lk ([string]$ows.Cells.Item($r, $cEmp).Text) ([string]$ows.Cells.Item($r, $cTit).Text)
          $situacao[$k] = $v
          $resgatadas++
        }
        if ($resgatadas) { Write-Output "Situacao: $resgatadas marcacoes resgatadas da planilha atual" }
      }
    } catch { Write-Warning "Nao consegui reler a planilha atual para preservar a Situacao: $($_.Exception.Message)" }
    finally { if ($old) { try { $old.Close($false) } catch {} } }
  }

  # 2) Aplica a situacao conhecida em cada vaga (novas entram como "Não Aplicada").
  foreach ($v in $vagas) {
    $k = Get-VagaKey $v.link $v.empresa $v.titulo_vaga
    $val = if ($situacao.ContainsKey($k)) { $situacao[$k] } else { $SIT_PADRAO }
    $v | Add-Member -NotePropertyName 'situacao' -NotePropertyValue $val -Force
    $situacao[$k] = $val
  }

  $wb = $excel.Workbooks.Add()
  # ensure three worksheets
  while ($wb.Worksheets.Count -lt 3) { $wb.Worksheets.Add() | Out-Null }

  # Sheet 1: Vagas — "Situacao" e a 1a coluna de proposito: e a que voce usa para trabalhar,
  # entao fica visivel sem rolar e da para filtrar por ela de cara.
  $ws1 = $wb.Worksheets.Item(1)
  Write-Sheet $ws1 'Vagas' `
    @('Situação','Empresa','Plataforma','Na sua lista?','Categoria do Cargo','Titulo da Vaga','Tipo','Local','Link para Candidatura','Nome na Plataforma','Publicado','Prazo Final','Alerta / Conferir','Detectada em') `
    @('situacao','empresa','plataforma','na_lista','cargo_categoria','titulo_vaga','tipo','local','link','nome_na_plataforma','publicado','prazo_final','alerta','detectado_em') `
    $vagas @('link') @(22,24,11,12,26,46,10,20,42,22,12,12,38,14) @(6,13) @(11,12,14)

  # Menu suspenso na coluna Situacao (lista fixa, sem digitacao livre).
  if (@($vagas).Count -gt 0) {
    $rngSit = $ws1.Range($ws1.Cells.Item(2,1), $ws1.Cells.Item(@($vagas).Count + 1, 1))
    $rngSit.Validation.Delete()
    # 3 = xlValidateList, 1 = xlValidAlertStop. O separador da lista no COM e virgula.
    $rngSit.Validation.Add(3, 1, 1, ($SIT_OPCOES -join ',')) | Out-Null
    $rngSit.Validation.IgnoreBlank = $true
    $rngSit.Validation.InCellDropdown = $true
    $rngSit.Validation.ShowError = $true
    $rngSit.Validation.ErrorTitle = 'Situação inválida'
    $rngSit.Validation.ErrorMessage = 'Escolha uma das opções: ' + ($SIT_OPCOES -join ' / ')
  }

  # Sheet 2: Presenca
  $ws2 = $wb.Worksheets.Item(2)
  Write-Sheet $ws2 'Presenca por Empresa' `
    @('Empresa','Tem Gupy?','Pagina Gupy','Tem InHire?','Pagina InHire','Total Vagas InHire') `
    @('empresa','gupy','gupy_url','inhire','inhire_url','inhire_vagas_total') `
    $presenca @('gupy_url','inhire_url') @(30,10,44,11,44,16) @() @()

  # Sheet 3: InHire novas (fora da lista)
  $ws3 = $wb.Worksheets.Item(3)
  Write-Sheet $ws3 'InHire novas (fora da lista)' `
    @('Empresa','Total de Vagas Abertas','Pagina de Carreiras') `
    @('empresa','vagas_total','url') `
    $novas @('url') @(38,20,46) @() @()

  $ws1.Activate()
  $wb.SaveAs($outPath, 51)

  # Guarda o estado duravel da coluna Situacao (sobrevive ate a planilha ser apagada).
  ($situacao.GetEnumerator() | Sort-Object Name | ForEach-Object -Begin { $o = [ordered]@{} } -Process { $o[$_.Name] = $_.Value } -End { $o }) |
    ConvertTo-Json | Set-Content -LiteralPath $SIT_FILE -Encoding UTF8
  $marcadas = @($situacao.Values | Where-Object { $_ -ne $SIT_PADRAO }).Count

  Write-Output "OK: Vagas=$($vagas.Count) rows, Presenca=$($presenca.Count) rows -> $outPath"
  Write-Output "Situacao: $marcadas vaga(s) marcadas fora de '$SIT_PADRAO' (estado em situacao.json)"
}
finally {
  # Sempre encerra o Excel, mesmo se algo acima falhar (evita instancia COM orfa segurando lock).
  if ($wb) { try { $wb.Close($false) } catch {} }
  try { $excel.Quit() } catch {}
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
