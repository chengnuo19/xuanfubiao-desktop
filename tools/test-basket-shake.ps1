$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class BasketShakeTestInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public static void MoveRelative(int dx, int dy) {
    mouse_event(MOUSEEVENTF_MOVE, unchecked((uint)dx), unchecked((uint)dy), 0, UIntPtr.Zero);
  }
}
"@

$helperPath = Join-Path $PSScriptRoot '..\apps\desktop\resources\win32-helper.ps1'
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = 'powershell.exe'
$startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helperPath`""
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$null = $process.Start()

try {
  $ready = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if ($ready.type -ne 'helper-ready') {
    throw "helper did not become ready: $($ready | ConvertTo-Json -Compress)"
  }

  $process.StandardInput.WriteLine('{"id":1,"cmd":"shake-selftest"}')
  $process.StandardInput.Flush()
  $response = $process.StandardOutput.ReadLine() | ConvertFrom-Json

  if (-not $response.ok) {
    throw "shake self-test failed: $($response | ConvertTo-Json -Compress)"
  }

  $process.StandardInput.WriteLine('{"id":2,"cmd":"shake-start"}')
  $process.StandardInput.Flush()
  $start = $process.StandardOutput.ReadLine() | ConvertFrom-Json
  if (-not $start.ok) {
    throw "mouse hook did not start: $($start | ConvertTo-Json -Compress)"
  }

  $originalCursor = New-Object BasketShakeTestInput+POINT
  [BasketShakeTestInput]::GetCursorPos([ref]$originalCursor) | Out-Null
  try {
    # 场景 1：微小抖动 / 拖窗微调（单次仅 10px），必须不触发误识别
    [BasketShakeTestInput]::SetCursorPos(900, 100) | Out-Null
    Start-Sleep -Milliseconds 50
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    foreach ($dx in @(10, -10, 10, -10, 10)) {
      Start-Sleep -Milliseconds 55
      [BasketShakeTestInput]::MoveRelative($dx, 0)
    }
    Start-Sleep -Milliseconds 55
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60

    $process.StandardInput.WriteLine('{"id":3,"cmd":"shake-take"}')
    $process.StandardInput.Flush()
    $takeJitter = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if ($takeJitter.detected) {
      throw "anti-jitter failed: small 10px jitter triggered shake"
    }

    # 场景 2：测试故意左右摇晃（单笔画 >= 40px，连续 4 次有效笔画 / 3 次反转），正常唤出
    # 为保证手势轨迹纯粹测试（不受当前宿主桌面是否恰好处于全屏/放映状态影响），先显式关闭静音过滤
    $process.StandardInput.WriteLine('{"id":4,"cmd":"shake-config","enabled":true,"sensitivity":"medium","suppressFullscreen":false}')
    $process.StandardInput.Flush()
    $cfg1 = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if (-not $cfg1.ok) { throw "shake-config suppressFullscreen=false failed" }

    Start-Sleep -Milliseconds 150
    [BasketShakeTestInput]::SetCursorPos(900, 200) | Out-Null
    Start-Sleep -Milliseconds 50
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    foreach ($stroke in @(40, -40, 40, -40)) {
      $half = [int]($stroke / 2)
      [BasketShakeTestInput]::MoveRelative($half, 0)
      Start-Sleep -Milliseconds 25
      [BasketShakeTestInput]::MoveRelative($half, 0)
      Start-Sleep -Milliseconds 50
    }
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60

    $process.StandardInput.WriteLine('{"id":5,"cmd":"shake-take"}')
    $process.StandardInput.Flush()
    $takeDeliberate = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if (-not $takeDeliberate.ok -or -not $takeDeliberate.detected) {
      throw "deliberate shake failed to trigger: $($takeDeliberate | ConvertTo-Json -Compress)"
    }

    # 场景 3：测试动态配置指令（shake-config 禁用后手势不再响应）
    $process.StandardInput.WriteLine('{"id":6,"cmd":"shake-config","enabled":false,"sensitivity":"medium","suppressFullscreen":false}')
    $process.StandardInput.Flush()
    $cfg2 = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if (-not $cfg2.ok) { throw "shake-config enabled=false failed" }

    Start-Sleep -Milliseconds 150
    [BasketShakeTestInput]::SetCursorPos(900, 200) | Out-Null
    Start-Sleep -Milliseconds 50
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    foreach ($stroke in @(40, -40, 40, -40)) {
      $half = [int]($stroke / 2)
      [BasketShakeTestInput]::MoveRelative($half, 0)
      Start-Sleep -Milliseconds 25
      [BasketShakeTestInput]::MoveRelative($half, 0)
      Start-Sleep -Milliseconds 50
    }
    [BasketShakeTestInput]::mouse_event([BasketShakeTestInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60

    $process.StandardInput.WriteLine('{"id":7,"cmd":"shake-take"}')
    $process.StandardInput.Flush()
    $takeDisabled = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if ($takeDisabled.detected) {
      throw "disabled shake unexpectedly triggered: $($takeDisabled | ConvertTo-Json -Compress)"
    }

    # 场景 4：恢复默认配置（开启手势、适中灵敏度、启用全屏/游戏静音保护）
    $process.StandardInput.WriteLine('{"id":8,"cmd":"shake-config","enabled":true,"sensitivity":"medium","suppressFullscreen":true}')
    $process.StandardInput.Flush()
    $cfg3 = $process.StandardOutput.ReadLine() | ConvertFrom-Json
    if (-not $cfg3.ok) { throw "shake-config reset failed" }
  } finally {
    [BasketShakeTestInput]::SetCursorPos($originalCursor.X, $originalCursor.Y) | Out-Null
  }

  Write-Output 'PASS: basket shake detector, anti-jitter, deliberate gesture, and shake-config'
} finally {
  if (-not $process.HasExited) {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(2000)) {
      $process.Kill()
    }
  }
  $process.Dispose()
}
