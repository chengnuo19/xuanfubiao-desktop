# 只结束 tools/e2e/start.sh 起的测试实例（按命令行里的调试端口和隔离 home 认），不碰你在用的悬浮标。
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  (($_.Name -eq 'electron.exe') -or ($_.Name -eq 'XuanFuBiao.exe')) -and
  (($_.CommandLine -like '*remote-debugging-port=9333*') -or ($_.CommandLine -like '*xfb-e2e-home*'))
})
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
"stopped $($procs.Count)"
