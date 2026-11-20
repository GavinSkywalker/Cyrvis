import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

import { isSensitiveMemoryText } from '../../memory-context';
import type { ResourceDescriptor } from '../types';
import type { PerceptionContext, PerceptionProvider } from './types';

const UI_FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$null = Add-Type -AssemblyName UIAutomationClient
$null = Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) {
  Write-Output 'null'
  exit 0
}
$current = $focused.Current
$bounds = $current.BoundingRectangle
$selection = $null
try {
  $pattern = $focused.GetCurrentPattern(
    [System.Windows.Automation.TextPattern]::Pattern
  )
  $ranges = @($pattern.GetSelection())
  if ($ranges.Count -gt 0) {
    $selection = (($ranges | ForEach-Object { $_.GetText(-1) }) -join [Environment]::NewLine)
  }
} catch {}
$process = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
[pscustomobject]@{
  name = [string]$current.Name
  role = [string]$current.ControlType.ProgrammaticName
  automationId = [string]$current.AutomationId
  className = [string]$current.ClassName
  processId = [int]$current.ProcessId
  process = if ($null -eq $process) { '' } else { [string]$process.ProcessName }
  enabled = [bool]$current.IsEnabled
  offscreen = [bool]$current.IsOffscreen
  selectedText = $selection
  bounds = @{
    x = [int]$bounds.X
    y = [int]$bounds.Y
    width = [int]$bounds.Width
    height = [int]$bounds.Height
  }
} | ConvertTo-Json -Depth 5 -Compress
`;

interface FocusedElement {
  name?: string;
  role?: string;
  automationId?: string;
  className?: string;
  processId?: number;
  process?: string;
  enabled?: boolean;
  offscreen?: boolean;
  selectedText?: string | null;
  bounds?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
}

export interface UiFocusPerceptionProviderOptions {
  id?: string;
  intervalMs?: number;
  ttlMs?: number;
  timeoutMs?: number;
  includeSelectedText?: boolean;
}

export class UiFocusPerceptionProvider implements PerceptionProvider {
  readonly id: string;
  readonly intervalMs: number;
  readonly ttlMs: number;
  readonly timeoutMs: number;

  constructor(private readonly options: UiFocusPerceptionProviderOptions = {}) {
    this.id = options.id || 'windows-ui-focus';
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 1_500);
    this.ttlMs = Math.max(
      this.intervalMs * 2,
      options.ttlMs ?? this.intervalMs * 4,
    );
    this.timeoutMs = Math.max(750, options.timeoutMs ?? 3_000);
  }

  async refresh(
    _context: PerceptionContext,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]> {
    if (process.platform !== 'win32' || signal.aborted) return [];
    const focused = await this.inspectFocus(signal);
    if (!focused || signal.aborted) return [];
    const identity = `${focused.processId || 0}:${focused.automationId || ''}:${focused.name || ''}`;
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    const selectedText =
      this.options.includeSelectedText !== false &&
      typeof focused.selectedText === 'string' &&
      !isSensitiveMemoryText(focused.selectedText)
        ? focused.selectedText.slice(0, 1_000)
        : null;
    return [
      {
        id: `control:${id}`,
        kind: 'control',
        name: focused.name || focused.role || '焦点控件',
        aliases: [
          focused.name || '',
          focused.role || '',
          focused.automationId || '',
          focused.process || '',
        ].filter(Boolean),
        source: `perception:${this.id}`,
        active: true,
        health: 'available',
        providerIds: [this.id],
        capabilities: ['ui.inspect', 'ui.action'],
        updatedAt: Date.now(),
        sensitivity: selectedText ? 'private' : 'public',
        confidence: 0.92,
        metadata: {
          name: focused.name || null,
          role: focused.role || null,
          automationId: focused.automationId || null,
          className: focused.className || null,
          processId: focused.processId || null,
          process: focused.process || null,
          enabled: focused.enabled ?? null,
          offscreen: focused.offscreen ?? null,
          selectedText,
          x: focused.bounds?.x ?? null,
          y: focused.bounds?.y ?? null,
          width: focused.bounds?.width ?? null,
          height: focused.bounds?.height ?? null,
        },
      },
    ];
  }

  private inspectFocus(signal: AbortSignal): Promise<FocusedElement | null> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const child = execFile(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
${UI_FOCUS_SCRIPT}`,
        ],
        {
          timeout: this.timeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
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
          const raw = stdout.replace(/^\uFEFF/, '').trim();
          if (!raw || raw === 'null') {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(raw) as FocusedElement);
          } catch {
            resolve(null);
          }
        },
      );
      signal.addEventListener(
        'abort',
        () => {
          child.kill();
          resolve(null);
        },
        { once: true },
      );
    });
  }
}
