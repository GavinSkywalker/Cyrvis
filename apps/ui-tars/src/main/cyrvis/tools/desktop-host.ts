/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from './types';

const APPLICATION_ALIASES: Record<
  string,
  { command: string; process: string; candidates?: string[] }
> = {
  记事本: { command: 'notepad.exe', process: 'notepad' },
  notepad: { command: 'notepad.exe', process: 'notepad' },
  计算器: { command: 'calc.exe', process: 'CalculatorApp' },
  calculator: { command: 'calc.exe', process: 'CalculatorApp' },
  画图: { command: 'mspaint.exe', process: 'mspaint' },
  paint: { command: 'mspaint.exe', process: 'mspaint' },
  资源管理器: { command: 'explorer.exe', process: 'explorer' },
  explorer: { command: 'explorer.exe', process: 'explorer' },
  文件资源管理器: { command: 'explorer.exe', process: 'explorer' },
  命令提示符: { command: 'cmd.exe', process: 'cmd' },
  terminal: { command: 'wt.exe', process: 'WindowsTerminal' },
  终端: { command: 'wt.exe', process: 'WindowsTerminal' },
  powershell: { command: 'powershell.exe', process: 'powershell' },
  vscode: { command: 'code.cmd', process: 'Code' },
  visualstudiocode: { command: 'code.cmd', process: 'Code' },
  code: { command: 'code.cmd', process: 'Code' },
  浏览器: { command: 'chrome.exe', process: 'chrome' },
  谷歌浏览器: { command: 'chrome.exe', process: 'chrome' },
  chrome浏览器: { command: 'chrome.exe', process: 'chrome' },
  chrome: { command: 'chrome.exe', process: 'chrome' },
  edge: { command: 'msedge.exe', process: 'msedge' },
  edge浏览器: { command: 'msedge.exe', process: 'msedge' },
  微软浏览器: { command: 'msedge.exe', process: 'msedge' },
  qq浏览器: {
    command: 'QQBrowser.exe',
    process: 'QQBrowser',
    candidates: [
      '%ProgramFiles%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%LOCALAPPDATA%\\Tencent\\QQBrowser\\Application\\QQBrowser.exe',
    ],
  },
  qqbrowser: {
    command: 'QQBrowser.exe',
    process: 'QQBrowser',
    candidates: [
      '%ProgramFiles%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%LOCALAPPDATA%\\Tencent\\QQBrowser\\Application\\QQBrowser.exe',
    ],
  },
  腾讯浏览器: {
    command: 'QQBrowser.exe',
    process: 'QQBrowser',
    candidates: [
      '%ProgramFiles%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%ProgramFiles(x86)%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%LOCALAPPDATA%\\Tencent\\QQBrowser\\Application\\QQBrowser.exe',
    ],
  },
  word: { command: 'winword.exe', process: 'WINWORD' },
  excel: { command: 'excel.exe', process: 'EXCEL' },
  powerpoint: { command: 'powerpnt.exe', process: 'POWERPNT' },
  vlc: { command: 'vlc.exe', process: 'vlc' },
  微信: { command: 'WeChat.exe', process: 'WeChat' },
  wechat: { command: 'WeChat.exe', process: 'WeChat' },
};

const normalizeAlias = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

const expandEnvironmentPath = (value: string): string =>
  value.replace(/%([^%]+)%/g, (match, name: string) => {
    return process.env[name] ?? match;
  });

const resolveApplicationCommand = async (
  alias: (typeof APPLICATION_ALIASES)[string],
): Promise<string> => {
  for (const candidate of alias.candidates || []) {
    const expanded = expandEnvironmentPath(candidate);
    try {
      await fs.access(expanded);
      return expanded;
    } catch {
      // Try the next known installation path.
    }
  }
  return alias.command;
};

export const isSupportedApplicationAlias = (value: string): boolean =>
  Boolean(APPLICATION_ALIASES[normalizeAlias(value)]);

const runPowerShell = (
  script: string,
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 20_000,
) =>
  new Promise<string>((resolve, reject) => {
    const utf8Script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
${script}
`;
    const encodedScript = Buffer.from(utf8Script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript,
      ],
      {
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              (stderr || stdout || error.message).trim() || error.message,
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });

const parseJson = <T>(value: string, fallback: T): T => {
  const trimmed = value.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed === 'null') {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
};

const launchDetached = (command: string, args: string[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });

const WINDOW_CONTROL_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CyrvisWindow {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool PostMessage(
    IntPtr hWnd,
    uint Msg,
    IntPtr wParam,
    IntPtr lParam
  );
}
"@
$query = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:CYRV_WINDOW_QUERY_B64)
)
$action = $env:CYRV_WINDOW_ACTION
$protectedPid = 0
[void][int]::TryParse([string]$env:CYRV_PROTECTED_PID, [ref]$protectedPid)
$protectedExe = [string]$env:CYRV_PROTECTED_EXE
$matches = @(Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    $_.ProcessName.IndexOf(
      $query,
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0 -or
    $_.MainWindowTitle.IndexOf(
      $query,
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0
  )
})
if ($matches.Count -eq 0) { throw "No matching window" }
$selectable = @($matches | Where-Object {
  if ($protectedPid -gt 0 -and $_.Id -eq $protectedPid) {
    return $false
  }
  if ([string]::IsNullOrWhiteSpace($protectedExe)) {
    return $true
  }
  try {
    return -not (
      $_.Path -and
      $_.Path.Equals($protectedExe, [StringComparison]::OrdinalIgnoreCase)
    )
  } catch {
    return $true
  }
})
if ($selectable.Count -eq 0) {
  throw "CYRVIS application windows are protected"
}
$ranked = @($selectable | ForEach-Object {
  $rank = 3
  if ($_.MainWindowTitle.Equals(
    $query,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    $rank = 0
  } elseif ($_.ProcessName.Equals(
    $query,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    $rank = 1
  } elseif ($_.MainWindowTitle.StartsWith(
    $query,
    [StringComparison]::OrdinalIgnoreCase
  )) {
    $rank = 2
  }
  [pscustomobject]@{ Process = $_; Rank = $rank }
} | Sort-Object -Property Rank)
$bestRank = $ranked[0].Rank
$best = @($ranked | Where-Object { $_.Rank -eq $bestRank })
if ($best.Count -gt 1) { throw "Window target is ambiguous" }
$target = $best[0].Process
if ($action -eq "focus") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 9)
  [void][CyrvisWindow]::SetForegroundWindow($target.MainWindowHandle)
} elseif ($action -eq "minimize") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 6)
} elseif ($action -eq "maximize") {
  [void][CyrvisWindow]::ShowWindow($target.MainWindowHandle, 3)
} elseif ($action -eq "close") {
  [void][CyrvisWindow]::PostMessage(
    $target.MainWindowHandle,
    0x0010,
    [IntPtr]::Zero,
    [IntPtr]::Zero
  )
} else {
  throw "Unknown window action: $action"
}
$payload = [pscustomobject]@{
  pid = [int]$target.Id
  process = $target.ProcessName
  title = $target.MainWindowTitle
} | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
`;

const CLOSE_BROWSER_TAB_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CyrvisBrowserTab {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
"@
$query = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:CYRV_BROWSER_TAB_QUERY_B64)
)
$browserNames = @(
  "chrome",
  "msedge",
  "brave",
  "vivaldi",
  "opera",
  "QQBrowser"
)
$found = @()
$tabType = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
foreach ($process in @(Get-Process | Where-Object {
  $browserNames -contains $_.ProcessName -and $_.MainWindowHandle -ne 0
})) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle(
      [IntPtr]$process.MainWindowHandle
    )
    if (-not $root) { continue }
    $tabs = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $tabType
    )
    foreach ($tab in $tabs) {
      $name = [string]$tab.Current.Name
      if (
        $name -and
        $name.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0
      ) {
        $found += [pscustomobject]@{
          Element = $tab
          Process = $process
          Title = $name
        }
      }
    }
  } catch {
    continue
  }
}
if ($found.Count -eq 0) {
  throw "No matching browser tab"
}
$exact = @($found | Where-Object {
  $_.Title.Equals($query, [StringComparison]::OrdinalIgnoreCase)
})
if ($exact.Count -eq 1) {
  $target = $exact[0]
} elseif ($found.Count -eq 1) {
  $target = $found[0]
} else {
  throw "Browser tab target is ambiguous"
}
[void][CyrvisBrowserTab]::SetForegroundWindow(
  [IntPtr]$target.Process.MainWindowHandle
)
try {
  $selection = $target.Element.GetCurrentPattern(
    [System.Windows.Automation.SelectionItemPattern]::Pattern
  )
  $selection.Select()
} catch {
  $target.Element.SetFocus()
}
Start-Sleep -Milliseconds 180
[CyrvisBrowserTab]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[CyrvisBrowserTab]::keybd_event(0x57, 0, 0, [UIntPtr]::Zero)
[CyrvisBrowserTab]::keybd_event(0x57, 0, 2, [UIntPtr]::Zero)
[CyrvisBrowserTab]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
$payload = [pscustomobject]@{
  process = $target.Process.ProcessName
  title = $target.Title
} | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
`;

const FOREGROUND_WINDOW_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CyrvisForeground {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$handle = [CyrvisForeground]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) {
  Write-Output "null"
  exit 0
}
$targetPid = [uint32]0
[void][CyrvisForeground]::GetWindowThreadProcessId($handle, [ref]$targetPid)
$target = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not $target) {
  Write-Output "null"
  exit 0
}
$builder = New-Object System.Text.StringBuilder 2048
[void][CyrvisForeground]::GetWindowText($handle, $builder, $builder.Capacity)
[pscustomobject]@{
  pid = [int]$targetPid
  process = $target.ProcessName
  title = $builder.ToString()
  handle = $handle.ToInt64()
  focused = $true
} | ConvertTo-Json -Compress
`;

const unsupported = (feature: string): never => {
  throw new Error(`${feature} is currently implemented for Windows only`);
};

export class LocalDesktopHost implements DesktopHost {
  async openPath(target: string): Promise<void> {
    // ShellExecute (shell.openPath) opens document associations in a visible
    // window. The old hidden PowerShell child could launch Notepad without a
    // window, and it also returned success even when nothing appeared.
    const { shell } = await import('electron');
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
  }

  async openUrl(url: string): Promise<void> {
    const { openUrl } = await import('../desktop-actions');
    await openUrl(url);
  }

  async openSearch(url: string): Promise<void> {
    const { openSearch } = await import('../desktop-actions');
    await openSearch(url);
  }

  async clipboardRead(): Promise<string> {
    if (process.platform === 'win32') {
      return runPowerShell('Get-Clipboard -Raw');
    }
    if (process.platform === 'darwin') {
      return new Promise<string>((resolve, reject) => {
        execFile('pbpaste', [], (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      });
    }
    return new Promise<string>((resolve, reject) => {
      execFile('xclip', ['-selection', 'clipboard', '-o'], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      );
    });
  }

  async clipboardWrite(text: string): Promise<void> {
    if (process.platform === 'win32') {
      await runPowerShell('Set-Clipboard -Value $env:CYRV_CLIPBOARD_TEXT', {
        CYRV_CLIPBOARD_TEXT: text,
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const command = process.platform === 'darwin' ? 'pbcopy' : 'xclip';
      const args =
        process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
      const child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
      child.stdin.end(text);
    });
  }

  async launchApplication(name: string, target?: string): Promise<string> {
    const aliasName = normalizeAlias(name);
    const canonical =
      (
        {
          记事本: 'notepad',
          资源管理器: 'explorer',
          文件资源管理器: 'explorer',
          code: 'vscode',
          visualstudiocode: 'vscode',
          浏览器: 'chrome',
          谷歌浏览器: 'chrome',
          chrome浏览器: 'chrome',
        } as Record<string, string>
      )[aliasName] || aliasName;
    if (['vscode', 'chrome', 'explorer', 'notepad'].includes(canonical)) {
      const { openApp } = await import('../desktop-actions');
      await openApp(
        canonical as import('../desktop-actions').AllowedApp,
        target,
      );
      return name.trim();
    }
    if (target)
      throw new Error('This application does not support an opening target');
    const alias = APPLICATION_ALIASES[normalizeAlias(name)];
    if (!alias) {
      throw new Error(`Unsupported application alias: ${name}`);
    }
    const command = await resolveApplicationCommand(alias);
    if (process.platform === 'win32') {
      await runPowerShell('Start-Process -FilePath $env:CYRV_APP_COMMAND', {
        CYRV_APP_COMMAND: command,
      });
    } else {
      await launchDetached(command);
    }
    return name.trim();
  }

  async closeApplication(name: string): Promise<string> {
    if (process.platform !== 'win32') {
      return unsupported('Closing applications');
    }
    const alias = APPLICATION_ALIASES[normalizeAlias(name)];
    const processName = alias?.process || name.trim();
    const executableName = path.basename(
      process.execPath,
      path.extname(process.execPath),
    );
    if (
      processName.toLowerCase() === executableName.toLowerCase() ||
      /^(?:cyrvis|cyrvis companion|electron)$/i.test(processName)
    ) {
      throw new Error('CYRVIS application processes are protected');
    }
    if (!/^[A-Za-z0-9_.-]+$/i.test(processName)) {
      throw new Error(
        'Application process name contains unsupported characters',
      );
    }
    await runPowerShell(
      `$name = $env:CYRV_APP_PROCESS
$protectedPid = 0
[void][int]::TryParse([string]$env:CYRV_PROTECTED_PID, [ref]$protectedPid)
$protectedExe = [string]$env:CYRV_PROTECTED_EXE
$targets = @(Get-Process -Name $name -ErrorAction Stop | Where-Object {
  if ($protectedPid -gt 0 -and $_.Id -eq $protectedPid) {
    return $false
  }
  if ([string]::IsNullOrWhiteSpace($protectedExe)) {
    return $true
  }
  try {
    return -not (
      $_.Path -and
      $_.Path.Equals($protectedExe, [StringComparison]::OrdinalIgnoreCase)
    )
  } catch {
    return $true
  }
})
if ($targets.Count -eq 0) {
  throw "Only CYRVIS application processes matched"
}
$targets | Stop-Process -Force`,
      {
        CYRV_APP_PROCESS: processName,
        CYRV_PROTECTED_PID: String(process.pid),
        CYRV_PROTECTED_EXE: process.execPath,
      },
    );
    return name.trim();
  }

  async closeBrowserPage(
    query: string,
  ): Promise<{ title: string; process: string }> {
    if (process.platform !== 'win32') {
      return unsupported('Closing browser tabs');
    }
    const output = await runPowerShell(
      CLOSE_BROWSER_TAB_SCRIPT,
      {
        CYRV_BROWSER_TAB_QUERY_B64: Buffer.from(query, 'utf8').toString(
          'base64',
        ),
      },
      12_000,
    );
    const payload = output.trim();
    if (!payload) {
      throw new Error('Browser tab closed without a verification payload.');
    }
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const parsed = parseJson<{ title: string; process: string } | null>(
      decoded,
      null,
    );
    if (!parsed?.title) {
      throw new Error('Browser tab close verification failed.');
    }
    return parsed;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    if (process.platform !== 'win32') {
      return this.listUnixProcesses();
    }
    const output = await runPowerShell(`
$items = Get-Process | Sort-Object -Property ProcessName | ForEach-Object {
  [pscustomobject]@{
    pid = $_.Id
    name = $_.ProcessName
    title = $_.MainWindowTitle
    memoryBytes = $_.WorkingSet64
  }
}
$items | ConvertTo-Json -Compress
`);
    const parsed = parseJson<ProcessInfo[] | ProcessInfo>(output, []);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (item) => item && typeof item.pid === 'number',
    );
  }

  async listWindows(): Promise<WindowInfo[]> {
    const processes = await this.listProcesses();
    return processes
      .filter((processInfo) => Boolean(processInfo.title?.trim()))
      .map((processInfo) => ({
        pid: processInfo.pid,
        process: processInfo.name,
        title: processInfo.title || '',
      }));
  }

  async getForegroundWindow(): Promise<WindowInfo | null> {
    if (process.platform !== 'win32') {
      return null;
    }
    const output = await runPowerShell(FOREGROUND_WINDOW_SCRIPT);
    return parseJson<WindowInfo | null>(output, null);
  }

  async showNotification(title: string, body: string): Promise<void> {
    const { Notification } = await import('electron');
    if (!Notification.isSupported()) {
      throw new Error('System notifications are not supported.');
    }
    new Notification({ title, body }).show();
  }

  async controlWindow(
    query: string,
    action: 'focus' | 'minimize' | 'maximize' | 'close',
  ): Promise<string> {
    if (process.platform !== 'win32') {
      return unsupported('Window control');
    }
    const output = await runPowerShell(WINDOW_CONTROL_SCRIPT, {
      CYRV_WINDOW_QUERY_B64: Buffer.from(query, 'utf8').toString('base64'),
      CYRV_WINDOW_ACTION: action,
      CYRV_PROTECTED_PID: action === 'close' ? String(process.pid) : '',
      CYRV_PROTECTED_EXE: action === 'close' ? process.execPath : '',
    });
    const decoded = Buffer.from(output.trim(), 'base64').toString('utf8');
    const target = parseJson<WindowInfo | null>(decoded, null);
    return target?.title || target?.process || query;
  }

  async minimizeAllWindows(): Promise<number> {
    if (process.platform !== 'win32') {
      return unsupported('Minimize all windows');
    }
    const count = (await this.listWindows()).length;
    await runPowerShell(
      '$shell = New-Object -ComObject Shell.Application; $shell.MinimizeAll()',
    );
    return count;
  }

  async restoreAllWindows(): Promise<number> {
    if (process.platform !== 'win32') {
      return unsupported('Restore all windows');
    }
    const count = (await this.listWindows()).length;
    await runPowerShell(
      '$shell = New-Object -ComObject Shell.Application; $shell.UndoMinimizeALL()',
    );
    return count;
  }

  async createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void> {
    if (process.platform !== 'win32') {
      return unsupported('PowerPoint presentation creation');
    }
    const script = `
$ppt = $null
$presentation = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $presentation = $ppt.Presentations.Add($false)
  $slide = $presentation.Slides.Add(1, 1)
  try {
    $slide.Shapes.Title.TextFrame.TextRange.Text = $env:CYRV_PPT_TITLE
  } catch {}
  if ($env:CYRV_PPT_SUBTITLE) {
    try {
      $slide.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text = $env:CYRV_PPT_SUBTITLE
    } catch {}
  }
  $presentation.SaveAs($env:CYRV_PPT_PATH, 24)
} finally {
  if ($presentation) {
    try { $presentation.Close() } catch {}
  }
  if ($ppt) {
    try { $ppt.Quit() } catch {}
  }
}`;
    await runPowerShell(script, {
      CYRV_PPT_PATH: input.path,
      CYRV_PPT_TITLE: input.title,
      CYRV_PPT_SUBTITLE: input.subtitle || '',
    });
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: process.platform,
      release: os.release(),
      architecture: os.arch(),
      hostname: os.hostname(),
      homeDirectory: os.homedir(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    };
  }

  async diskInfo(target: string): Promise<DiskInfo> {
    const stats = await fs.statfs(target);
    return {
      path: target,
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
    };
  }

  private async listUnixProcesses(): Promise<ProcessInfo[]> {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-eo', 'pid=,comm=,rss='],
        { maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const processes = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+?)\s+(\d+)$/);
        if (!match) {
          return null;
        }
        return {
          pid: Number(match[1]),
          name: match[2],
          memoryBytes: Number(match[3]) * 1024,
        } satisfies ProcessInfo;
      });
    return processes.filter(
      (item): item is NonNullable<(typeof processes)[number]> => item !== null,
    );
  }
}
