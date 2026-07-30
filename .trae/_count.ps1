$dirs = @(
  'miniprogram\utils',
  'miniprogram\pages',
  'miniprogram\components',
  'cloudfunctions\reportAI',
  'cloudfunctions\ocrService',
  'cloudfunctions\conversationAI',
  'cloudfunctions\_shared',
  'cloudfunctions\dataWrite',
  'cloudfunctions\dataQuery'
)
foreach ($d in $dirs) {
  if (Test-Path $d) {
    Get-ChildItem $d -Recurse -File -Filter '*.js' | ForEach-Object {
      $lines = (Get-Content $_.FullName | Measure-Object -Line).Lines
      $rel = $_.FullName.Replace('c:\Users\lyy\WeChatProjects\miniprogram-1\', '')
      Write-Output ('{0,5}  {1}' -f $lines, $rel)
    }
  }
}
