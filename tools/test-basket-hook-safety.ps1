$ErrorActionPreference = 'Stop'

# 1. 提取 win32-helper.ps1 的 $nativeSource C# 源码
$helperPath = Join-Path $PSScriptRoot '../apps/desktop/resources/win32-helper.ps1'
if (-not (Test-Path $helperPath)) { throw "win32-helper.ps1 not found: $helperPath" }
$helperText = Get-Content $helperPath -Raw -Encoding UTF8
$startMarker = '$nativeSource = @"'
$startIdx = $helperText.IndexOf($startMarker) + $startMarker.Length
$endIdx = $helperText.IndexOf('"' + '@', $startIdx)
if ($startIdx -lt $startMarker.Length -or $endIdx -le $startIdx) { throw "Failed to extract `$nativeSource" }
$src = $helperText.Substring($startIdx, $endIdx - $startIdx)

# 2. 替换 PInvoke 为假实现并注入测试状态字段
$fakeImpl = @"
  public static int TestQueryThreadId = 0;
  public static int TestQueryCount = 0;
  public static long TestHitResult = 1;
  public static bool TestSendMessageSuccess = true;
  public static int TestQunsState = 5;
  public static IntPtr CallNextHookEx(IntPtr h, int c, IntPtr m, IntPtr d) { return IntPtr.Zero; }
  public static IntPtr WindowFromPoint(POINT p) { return (IntPtr)0x1234; }
  public static IntPtr GetAncestor(IntPtr h, uint f) { return h; }
  public static IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint u, out IntPtr r) {
    TestQueryThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
    System.Threading.Thread.Sleep(150);
    System.Threading.Interlocked.Increment(ref TestQueryCount);
    r = (IntPtr)TestHitResult;
    return TestSendMessageSuccess ? (IntPtr)1 : IntPtr.Zero;
  }
  public static int SHQueryUserNotificationState(out int q) { q = TestQunsState; return 0; }
"@

$src = $src -replace '\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr CallNextHookEx\(.*?\);', ''
$src = $src -replace '\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr WindowFromPoint\(.*?\);', ''
$src = $src -replace '\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr GetAncestor\(.*?\);', ''
$src = $src -replace '\[DllImport\("user32\.dll"\)\]\s*public static extern IntPtr SendMessageTimeout\(.*?\);', ''
$src = $src -replace '\[DllImport\("shell32\.dll"\)\]\s*public static extern int SHQueryUserNotificationState\(.*?\);', $fakeImpl

Add-Type -TypeDefinition $src

# 3. 反射获取 ShakeMouseProc 并分配 MSLLHOOKSTRUCT 指针
$shakeProc = [Xfb].GetMethod('ShakeMouseProc', [System.Reflection.BindingFlags]'NonPublic,Static')
if ($null -eq $shakeProc) { throw "ShakeMouseProc not found" }
$hookStruct = New-Object Xfb+MSLLHOOKSTRUCT
$hookSize = [System.Runtime.InteropServices.Marshal]::SizeOf([Type][Xfb+MSLLHOOKSTRUCT])
$hookPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($hookSize)

function Send-InputEvent([int]$msg, [int]$x, [int]$y, [uint32]$t = 0) {
  $pt = New-Object Xfb+POINT; $pt.X = $x; $pt.Y = $y
  $hookStruct.Point = $pt
  $hookStruct.Time = $t
  [System.Runtime.InteropServices.Marshal]::StructureToPtr($hookStruct, $hookPtr, $false)
  $null = $shakeProc.Invoke($null, @([int]0, [IntPtr]$msg, $hookPtr))
}

function Invoke-Shake([int]$x = 500, [int]$y = 500, [uint32]$t = 1000) {
  Send-InputEvent 0x0200 ($x + 40) $y ($t + 80)
  Send-InputEvent 0x0200 $x $y ($t + 160)
  Send-InputEvent 0x0200 ($x + 40) $y ($t + 240)
  Send-InputEvent 0x0200 $x $y ($t + 320)
}

function Wait-ClassificationQuery([int]$target) {
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while ([Xfb]::TestQueryCount -lt $target -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
  if ([Xfb]::TestQueryCount -lt $target) { throw "Timeout waiting for classification query" }
  Start-Sleep -Milliseconds 25
}

function Test-Gesture([long]$hit, [bool]$success, [bool]$suppress, [uint32]$baseTime, [bool]$wait = $true) {
  [Xfb]::TestHitResult = $hit
  [Xfb]::TestSendMessageSuccess = $success
  [Xfb]::ShakeSuppressFullscreen = $suppress
  $q = [Xfb]::TestQueryCount + 1
  Send-InputEvent 0x0201 500 500 $baseTime
  if ($wait) { Wait-ClassificationQuery $q }
  Invoke-Shake 500 500 $baseTime
  Send-InputEvent 0x0202 500 500 ($baseTime + 350)
  return [Xfb]::ConsumeShake()
}

try {
  # 预热排除 JIT 影响
  [Xfb]::ShakeEnabled = $true
  $null = Test-Gesture 1 $true $false 0 $true
  $null = [Xfb]::ConsumeShake()

  # 1. 窗口查询耗时 150ms 下，按下事件返回 < 75ms，且查询线程不同于回调线程
  $q1 = [Xfb]::TestQueryCount + 1
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Send-InputEvent 0x0201 500 500 1000
  $sw.Stop()
  if ($sw.ElapsedMilliseconds -ge 75) { throw "Verification 1: down took $($sw.ElapsedMilliseconds)ms (>= 75ms)" }
  Wait-ClassificationQuery $q1
  if ([Xfb]::TestQueryThreadId -eq [System.Threading.Thread]::CurrentThread.ManagedThreadId) {
    throw "Verification 1: query thread must differ from callback thread"
  }
  Send-InputEvent 0x0202 500 500 1010
  $null = [Xfb]::ConsumeShake()

  # 2. 正常 HTCLIENT=1 在分类完成后左右 40px/80ms 轨迹可以触发一次且一次性消费
  if (-not (Test-Gesture 1 $true $false 2000)) { throw "Verification 2: HTCLIENT should trigger shake" }
  if ([Xfb]::ConsumeShake()) { throw "Verification 2: shake consumed more than once" }

  # 3. HTCAPTION=2、窗口边框 10、命中查询超时均不能触发
  if (Test-Gesture 2 $true $false 3000) { throw "Verification 3: HTCAPTION must not trigger" }
  if (Test-Gesture 10 $true $false 4000) { throw "Verification 3: border 10 must not trigger" }
  if (Test-Gesture 1 $false $false 5000) { throw "Verification 3: query timeout must not trigger" }

  # 4. 禁用 ShakeEnabled 时点击不发出窗口查询且不触发
  [Xfb]::ShakeEnabled = $false
  $qBefore4 = [Xfb]::TestQueryCount
  $res4 = Test-Gesture 1 $true $false 6000 $false
  if ([Xfb]::TestQueryCount -ne $qBefore4 -or $res4) { throw "Verification 4: query issued or triggered when disabled" }
  [Xfb]::ShakeEnabled = $true

  # 5. 全屏开启抑制时 ConsumeShake 不返回信号，关闭抑制则允许
  [Xfb]::TestQunsState = 3 # QUNS_RUNNING_D3D_FULL_SCREEN
  if (Test-Gesture 1 $true $true 7000) { throw "Verification 5: fullscreen suppression failed to block shake" }
  if (-not (Test-Gesture 1 $true $false 8000)) { throw "Verification 5: disabling fullscreen suppression should allow shake" }
  [Xfb]::TestQunsState = 5

  # 6. 鼠标松开后旧异步分类结果不能使下次未完成分类的拖动触发
  $q6a = [Xfb]::TestQueryCount + 1
  Send-InputEvent 0x0201 500 500 9000
  Start-Sleep -Milliseconds 10
  Send-InputEvent 0x0202 500 500 9010
  Wait-ClassificationQuery $q6a

  $q6b = [Xfb]::TestQueryCount + 1
  Send-InputEvent 0x0201 500 500 10000
  Invoke-Shake 500 500 10000
  Send-InputEvent 0x0202 500 500 10350
  if ([Xfb]::ConsumeShake()) { throw "Verification 6: stale async result leaked to new drag" }
  Wait-ClassificationQuery $q6b

  # 7. Xfb.ShakeSelfTest() 通过
  if (-not [Xfb]::ShakeSelfTest()) { throw "Verification 7: ShakeSelfTest() returned false" }

  Write-Output 'PASS: basket hook safety and gesture regression tests'
} finally {
  if ($hookPtr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($hookPtr) }
}
