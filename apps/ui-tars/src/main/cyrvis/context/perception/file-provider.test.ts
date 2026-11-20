import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FilePerceptionProvider } from './file-provider';

describe('FilePerceptionProvider', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-files-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers bounded file metadata and filters sensitive filenames', async () => {
    await fs.writeFile(path.join(root, 'report.txt'), 'hello', 'utf8');
    await fs.writeFile(path.join(root, '.env'), 'secret', 'utf8');
    const provider = new FilePerceptionProvider({
      roots: [root],
      intervalMs: 500,
    });
    const resources = await provider.refresh(
      {
        now: Date.now(),
        system: null,
        user: {
          revision: 0,
          updatedAt: 0,
          activeApplication: null,
          activeWindow: null,
          focusedControl: null,
          selectedText: null,
          clipboard: null,
          recentRequest: null,
          recentActions: [],
          recentResourceIds: [],
          currentTask: null,
        },
      },
      new AbortController().signal,
    );
    expect(resources).toContainEqual(
      expect.objectContaining({
        kind: 'file',
        name: 'report.txt',
        source: 'perception.filesystem',
      }),
    );
    expect(resources.some((resource) => resource.name === '.env')).toBe(false);
    provider.dispose();
  });
});
