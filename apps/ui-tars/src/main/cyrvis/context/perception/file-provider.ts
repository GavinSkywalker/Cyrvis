import fs from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';

import type { ResourceDescriptor } from '../types';
import type { PerceptionProvider } from './types';

const MAX_FILES = 240;
const SENSITIVE_PATH =
  /(?:^|[\\/_.-])(?:\.env|password|passwd|secret|token|credential|privatekey|id_rsa|bank)(?:[\\/_.-]|$)/i;

export interface FilePerceptionProviderOptions {
  roots: string[];
  intervalMs?: number;
  ttlMs?: number;
  maxFiles?: number;
}

export class FilePerceptionProvider implements PerceptionProvider {
  readonly id = 'filesystem-watch';
  readonly intervalMs: number;
  readonly ttlMs: number;
  readonly timeoutMs = 4_000;
  private readonly roots: string[];
  private readonly maxFiles: number;
  private readonly watchers: FSWatcher[] = [];
  private dirty = true;
  private cache: ResourceDescriptor[] = [];

  constructor(options: FilePerceptionProviderOptions) {
    this.roots = [...new Set(options.roots.map((root) => path.resolve(root)))];
    this.intervalMs =
      typeof options.intervalMs === 'number' &&
      Number.isFinite(options.intervalMs)
        ? Math.max(500, options.intervalMs)
        : 2_000;
    this.ttlMs = Math.max(5_000, options.ttlMs ?? 30_000);
    this.maxFiles = Math.max(
      20,
      Math.min(1_000, options.maxFiles ?? MAX_FILES),
    );
    for (const root of this.roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => {
          this.dirty = true;
        });
        watcher.on('error', () => undefined);
        this.watchers.push(watcher);
      } catch {
        // Missing or unsupported watched directories are ignored.
      }
    }
  }

  async refresh(
    _context: Parameters<PerceptionProvider['refresh']>[0],
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]> {
    if (!this.dirty) return this.cache;
    const resources: ResourceDescriptor[] = [];
    const now = Date.now();
    for (const root of this.roots) {
      if (signal.aborted) break;
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (resources.length >= this.maxFiles) break;
          if (!entry.isFile()) continue;
          const target = path.join(root, entry.name);
          if (SENSITIVE_PATH.test(target)) continue;
          try {
            const stat = await fs.stat(target);
            resources.push({
              id: `file:${process.platform === 'win32' ? target.toLowerCase() : target}`,
              kind: 'file',
              name: entry.name,
              aliases: [entry.name.toLowerCase(), target.toLowerCase()],
              source: 'perception.filesystem',
              active: false,
              health: 'available',
              providerIds: ['filesystem'],
              capabilities: [
                'fs.get_info',
                'fs.open',
                'fs.read_file',
                'fs.write_file',
                'fs.hash',
              ],
              updatedAt: stat.mtimeMs,
              lastSeenAt: now,
              expiresAt: now + this.ttlMs,
              confidence: 1,
              sensitivity: 'private',
              metadata: {
                path: target,
                directory: root,
                size: stat.size,
                modifiedAt: stat.mtimeMs,
                extension: path.extname(entry.name).toLowerCase(),
              },
            });
          } catch {
            // The file can disappear while being inspected.
          }
        }
      } catch {
        // An unavailable watched root should not fail the whole provider.
      }
    }
    this.cache = resources;
    this.dirty = false;
    return resources;
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }
}
