import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ProcessInfo, WindowInfo } from '../tools/types';

export interface SystemRuntimeObservation {
  observedAt: number;
  foreground: WindowInfo | null;
  processes: ProcessInfo[];
  windows: WindowInfo[];
}

export interface SystemRuntimeMonitorOptions {
  scriptPath?: string;
  intervalMs?: number;
  restartDelayMs?: number;
  onObservation: (observation: SystemRuntimeObservation) => void;
  onError?: (error: Error) => void;
}

const scriptCandidates = (configured?: string): string[] => [
  ...(configured ? [configured] : []),
  path.resolve(process.cwd(), 'scripts/cyrvis/system-runtime-events.ps1'),
  path.resolve(
    process.cwd(),
    '..',
    '..',
    'scripts/cyrvis/system-runtime-events.ps1',
  ),
  path.resolve(
    process.resourcesPath || '',
    'scripts/cyrvis/system-runtime-events.ps1',
  ),
  path.resolve(process.resourcesPath || '', 'system-runtime-events.ps1'),
];

const normalizeObservation = (value: unknown): SystemRuntimeObservation => {
  if (!value || typeof value !== 'object') {
    throw new Error('Runtime monitor returned an invalid payload.');
  }
  const record = value as Record<string, unknown>;
  const processes = Array.isArray(record.processes)
    ? record.processes.filter((entry): entry is ProcessInfo =>
        Boolean(
          entry &&
            typeof entry === 'object' &&
            typeof (entry as ProcessInfo).pid === 'number' &&
            typeof (entry as ProcessInfo).name === 'string',
        ),
      )
    : [];
  const windows = Array.isArray(record.windows)
    ? record.windows.filter((entry): entry is WindowInfo =>
        Boolean(
          entry &&
            typeof entry === 'object' &&
            typeof (entry as WindowInfo).pid === 'number' &&
            typeof (entry as WindowInfo).process === 'string' &&
            typeof (entry as WindowInfo).title === 'string',
        ),
      )
    : [];
  const foreground =
    record.foreground &&
    typeof record.foreground === 'object' &&
    typeof (record.foreground as WindowInfo).pid === 'number' &&
    typeof (record.foreground as WindowInfo).process === 'string'
      ? (record.foreground as WindowInfo)
      : null;
  return {
    observedAt:
      typeof record.observedAt === 'number' ? record.observedAt : Date.now(),
    foreground,
    processes,
    windows,
  };
};

export class SystemRuntimeMonitor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly options: SystemRuntimeMonitorOptions) {}

  start(): boolean {
    if (process.platform !== 'win32' || this.child) {
      return false;
    }
    const script = scriptCandidates(this.options.scriptPath).find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!script) {
      this.reportError(new Error('System runtime event script was not found.'));
      return false;
    }
    this.stopped = false;
    try {
      const child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CYRVIS_RUNTIME_MONITOR_INTERVAL_MS: String(
              Math.max(250, this.options.intervalMs ?? 500),
            ),
          },
        },
      ) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdin.end();
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.options.onObservation(normalizeObservation(JSON.parse(line)));
          } catch (error) {
            this.reportError(error);
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const message = chunk.trim();
        if (message) this.reportError(new Error(message));
      });
      child.once('error', (error) => this.reportError(error));
      child.once('exit', () => {
        this.child = null;
        if (!this.stopped) this.scheduleRestart();
      });
      return true;
    } catch (error) {
      this.stopped = true;
      this.reportError(error);
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill();
    this.child = null;
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null;
        this.start();
      },
      Math.max(500, this.options.restartDelayMs ?? 2_000),
    );
    this.restartTimer.unref?.();
  }

  private reportError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
