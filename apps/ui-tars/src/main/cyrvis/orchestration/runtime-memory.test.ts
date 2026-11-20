import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RuntimeMemoryStore } from './runtime-memory';

describe('RuntimeMemoryStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-memory-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stores safe episodic memories, filters secrets, and persists them', async () => {
    const stateFile = path.join(root, 'memory.json');
    const now = 10_000;
    const memory = new RuntimeMemoryStore({ stateFile, now: () => now });
    await memory.ready();
    await memory.append({
      kind: 'user-request',
      text: '整理今天的任务',
    });
    await memory.append({
      kind: 'user-request',
      // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
      text: 'password: abcdef123456',
    });
    expect(memory.snapshot().entries).toHaveLength(1);
    expect(memory.getContext()).toContain('整理今天的任务');

    const restored = new RuntimeMemoryStore({
      stateFile,
      now: () => now + 1_000,
    });
    await restored.ready();
    expect(restored.snapshot().entries).toHaveLength(1);
    expect(restored.search('任务')[0]).toMatchObject({
      kind: 'user-request',
    });
  });
});
