import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DesktopHost, ToolContext } from './types';
import { DOCUMENT_TOOLS } from './document-tools';

const roots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-document-'));
  roots.push(root);
  return root;
};

const createContext = (root: string): ToolContext => ({
  cwd: root,
  homeDirectory: os.homedir(),
  platform: process.platform,
  desktop: {} as DesktopHost,
  resolvePath: (input) => path.resolve(root, input),
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('document and archive tools', () => {
  it('extracts UTF-8 text from a local document', async () => {
    const root = await createRoot();
    const file = path.join(root, 'notes.txt');
    await fs.writeFile(file, 'hello document', 'utf8');
    const tool = DOCUMENT_TOOLS.find(
      (entry) => entry.name === 'document.extract_text',
    )!;
    const context = createContext(root);
    const args = await tool.prepare({ path: file }, context);
    const result = await tool.execute(args, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        text: 'hello document',
      },
    });
  });

  it.runIf(process.platform === 'win32')(
    'creates and extracts a ZIP archive',
    async () => {
      const root = await createRoot();
      const source = path.join(root, 'source');
      const archive = path.join(root, 'bundle.zip');
      const destination = path.join(root, 'extracted');
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'a.txt'), 'archive', 'utf8');
      const context = createContext(root);
      const create = DOCUMENT_TOOLS.find(
        (entry) => entry.name === 'archive.create',
      )!;
      const extract = DOCUMENT_TOOLS.find(
        (entry) => entry.name === 'archive.extract',
      )!;

      const createArgs = await create.prepare(
        { source, destination: archive },
        context,
      );
      expect((await create.execute(createArgs, context)).ok).toBe(true);
      const extractArgs = await extract.prepare(
        { archive, destination },
        context,
      );
      expect((await extract.execute(extractArgs, context)).ok).toBe(true);
      expect(
        await fs.readFile(path.join(destination, 'source', 'a.txt'), 'utf8'),
      ).toBe('archive');
    },
    15_000,
  );
});
