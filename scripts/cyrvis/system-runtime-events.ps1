$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CyrvisRuntimeNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(
    IntPtr hWnd,
    StringBuilder text,
    int count
  );

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(
    IntPtr hWnd,
    out uint processId
  );

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  public static IntPtr[] VisibleWindows() {
    var values = new List<IntPtr>();
    EnumWindows((handle, _) => {
      if (IsWindowVisible(handle) && GetWindowTextLength(handle) > 0) {
        values.Add(handle);
      }
      return true;
    }, IntPtr.Zero);
    return values.ToArray();
  }
}
"@

$interval = 500
if ($env:CYRVIS_RUNTIME_MONITOR_INTERVAL_MS) {
  $parsed = 0
  if ([int]::TryParse($env:CYRVIS_RUNTIME_MONITOR_INTERVAL_MS, [ref]$parsed)) {
    $interval = [Math]::Max(250, [Math]::Min(5000, $parsed))
  }
}

$lastSignature = ''
while ($true) {
  try {
    $processes = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
      $windowTitle = [string]$_.MainWindowTitle
      [pscustomobject]@{
        pid = [int]$_.Id
        name = [string]$_.ProcessName
        title = $windowTitle
        memoryBytes = [long]$_.WorkingSet64
      }
    })

    $processNames = @{}
    foreach ($process in $processes) {
      $processNames[[int]$process.pid] = [string]$process.name
    }

    $windows = @()
    foreach ($handle in [CyrvisRuntimeNative]::VisibleWindows()) {
      $builder = New-Object System.Text.StringBuilder 2048
      [void][CyrvisRuntimeNative]::GetWindowText(
        $handle,
        $builder,
        $builder.Capacity
      )
      $title = $builder.ToString()
      if ([string]::IsNullOrWhiteSpace($title)) {
        continue
      }
      $targetPid = [uint32]0
      [void][CyrvisRuntimeNative]::GetWindowThreadProcessId(
        $handle,
        [ref]$targetPid
      )
      $windows += [pscustomobject]@{
        pid = [int]$targetPid
        process = [string]$processNames[[int]$targetPid]
        title = $title
        handle = [long]$handle.ToInt64()
      }
    }
    if ($windows.Count -eq 0) {
      $windows = @($processes | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_.title)
      } | ForEach-Object {
        [pscustomobject]@{
          pid = [int]$_.pid
          process = [string]$_.name
          title = [string]$_.title
        }
      })
    }

    $foregroundHandle = [CyrvisRuntimeNative]::GetForegroundWindow()
    $foreground = $null
    if ($foregroundHandle -ne [IntPtr]::Zero) {
      $foregroundPid = [uint32]0
      [void][CyrvisRuntimeNative]::GetWindowThreadProcessId(
        $foregroundHandle,
        [ref]$foregroundPid
      )
      $foregroundBuilder = New-Object System.Text.StringBuilder 2048
      [void][CyrvisRuntimeNative]::GetWindowText(
        $foregroundHandle,
        $foregroundBuilder,
        $foregroundBuilder.Capacity
      )
      $foreground = [pscustomobject]@{
        pid = [int]$foregroundPid
        process = [string]$processNames[[int]$foregroundPid]
        title = $foregroundBuilder.ToString()
        handle = [long]$foregroundHandle.ToInt64()
        focused = $true
      }
    }

    $payload = [pscustomobject]@{
      observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      foreground = $foreground
      processes = $processes
      windows = $windows
    } | ConvertTo-Json -Depth 6 -Compress

    $processSignature = ($processes | ForEach-Object {
      "$($_.pid)|$($_.name)|$($_.title)"
    }) -join ';'
    $windowSignature = ($windows | ForEach-Object {
      "$($_.pid)|$($_.process)|$($_.title)|$($_.handle)"
    }) -join ';'
    $signature = "$($foregroundHandle.ToInt64())|$processSignature|$windowSignature"
    if ($signature -ne $lastSignature) {
      $lastSignature = $signature
      [Console]::Out.WriteLine($payload)
      [Console]::Out.Flush()
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.Flush()
  }
  Start-Sleep -Milliseconds $interval
}
