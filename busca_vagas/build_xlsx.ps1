$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$outPath = Join-Path (Split-Path -Parent $dir) 'vagas_gupy_inhire.xlsx'

$vagas    = Get-Content "$dir\vagas_final.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$presenca = Get-Content "$dir\presence_combined.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$novas    = Get-Content "$dir\inhire_new_companies.json" -Raw -Encoding UTF8 | ConvertFrom-Json

$INV = [Globalization.CultureInfo]::InvariantCulture

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
  $wb = $excel.Workbooks.Add()
  # ensure three worksheets
  while ($wb.Worksheets.Count -lt 3) { $wb.Worksheets.Add() | Out-Null }

  # Sheet 1: Vagas
  $ws1 = $wb.Worksheets.Item(1)
  Write-Sheet $ws1 'Vagas' `
    @('Empresa','Plataforma','Na sua lista?','Categoria do Cargo','Titulo da Vaga','Tipo','Local','Link para Candidatura','Nome na Plataforma','Publicado','Prazo Final','Alerta / Conferir','Detectada em') `
    @('empresa','plataforma','na_lista','cargo_categoria','titulo_vaga','tipo','local','link','nome_na_plataforma','publicado','prazo_final','alerta','detectado_em') `
    $vagas @('link') @(24,11,12,26,46,10,20,42,22,12,12,38,14) @(5,12) @(10,11,13)

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
  Write-Output "OK: Vagas=$($vagas.Count) rows, Presenca=$($presenca.Count) rows -> $outPath"
}
finally {
  # Sempre encerra o Excel, mesmo se algo acima falhar (evita instancia COM orfa segurando lock).
  if ($wb) { try { $wb.Close($false) } catch {} }
  try { $excel.Quit() } catch {}
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
