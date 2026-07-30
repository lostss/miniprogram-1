$dirs = @(
  'miniprogram\utils',
  'miniprogram\pages',
  'miniprogram\components',
  'cloudfunctions\reportAI',
  'cloudfunctions\ocrService'
)
$results = @()
foreach ($d in $dirs) {
  if (Test-Path $d) {
    Get-ChildItem $d -Recurse -File -Filter '*.js' | ForEach-Object {
      $lines = (Get-Content $_.FullName | Measure-Object -Line).Lines
      $rel = $_.FullName.Replace('c:\Users\lyy\WeChatProjects\miniprogram-1\', '')
      $results += [PSCustomObject]@{Lines=$lines; Path=$rel}
    }
  }
}
$results | Sort-Object Lines | Format-Table -AutoSize
