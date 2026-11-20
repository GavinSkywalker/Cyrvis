import fs from 'node:fs/promises';

const DEFAULT_MODEL = 'qwen-doc-turbo';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MAX_PRESENTATION_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_CONTENT_CHARS = 20_000;
const TRUSTED_QWEN_DOWNLOAD_SUFFIXES = [
  'aliyuncs.com',
  'aliyun.com',
  'alibabacloud.com',
  'qianwenaiapi.com',
  'qianwen.com',
];
const PPT_TEMPLATE_IDS = new Set([
  'news_01',
  'summary_01',
  'internet_01',
  'thesis_01',
]);

export type QwenDocPptMode = 'general' | 'creative';

export interface QwenDocPresentationInput {
  path: string;
  title: string;
  subtitle?: string;
  content?: string;
  sourceFileId?: string;
  mode?: QwenDocPptMode;
  templateId?: string;
  pageCount?: number;
  audience?: string;
}

export interface QwenDocPresentationResult {
  provider: 'qwen-doc-turbo';
  model: string;
  mode: QwenDocPptMode;
  templateId: string | null;
  downloadHost: string;
  bytes: number;
}

export interface QwenDocStreamResult {
  content: string;
  reasoning: string;
}

export interface QwenDocRuntimeConfig {
  apiKey?: string;
  baseUrl?: string;
  workspaceId?: string;
  model?: string;
}

export type QwenDocProgressHandler = (
  message: string,
  percent?: number,
) => void;

let runtimeConfig: QwenDocRuntimeConfig = {};

type QwenDocApiKeyCandidate = {
  source: string;
  value: string;
};

export const configureQwenDocPresentation = (
  config: QwenDocRuntimeConfig,
): void => {
  runtimeConfig = {
    apiKey: config.apiKey?.trim() || undefined,
    baseUrl: config.baseUrl?.trim() || undefined,
    workspaceId: config.workspaceId?.trim() || undefined,
    model: config.model?.trim() || undefined,
  };
};

const qwenDocApiKeyCandidates = (): QwenDocApiKeyCandidate[] => {
  const candidates = [
    {
      source: 'CYRVIS_QWEN_DOC_API_KEY',
      value: process.env.CYRVIS_QWEN_DOC_API_KEY?.trim() || '',
    },
    {
      source: 'conversation runtime',
      value: runtimeConfig.apiKey?.trim() || '',
    },
    {
      source: 'DASHSCOPE_API_KEY',
      value: process.env.DASHSCOPE_API_KEY?.trim() || '',
    },
    {
      source: 'QWEN_API_KEY',
      value: process.env.QWEN_API_KEY?.trim() || '',
    },
  ];
  const seen = new Set<string>();
  return candidates.filter(({ value }) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};

const qwenDocApiKey = (): string => qwenDocApiKeyCandidates()[0]?.value || '';

export const isQwenDocConfigured = (): boolean => Boolean(qwenDocApiKey());

const qwenDocBaseUrl = (): URL => {
  const explicit = process.env.CYRVIS_QWEN_DOC_BASE_URL?.trim();
  if (explicit || runtimeConfig.baseUrl) {
    return validateHttpsUrl(
      explicit || runtimeConfig.baseUrl!,
      'CYRVIS_QWEN_DOC_BASE_URL',
    );
  }
  const workspaceId =
    process.env.CYRVIS_QWEN_DOC_WORKSPACE_ID?.trim() ||
    runtimeConfig.workspaceId ||
    process.env.QWEN_WORKSPACE_ID?.trim() ||
    '';
  if (workspaceId) {
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
      throw new Error(
        'CYRVIS_QWEN_DOC_WORKSPACE_ID 只能包含字母、数字、下划线和连字符。',
      );
    }
    return new URL(
      `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`,
    );
  }
  return new URL(DEFAULT_BASE_URL);
};

const validateHttpsUrl = (value: string, name: string): URL => {
  const url = new URL(value);
  const localHttp =
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${name} 必须使用 HTTPS，或使用本机回环 HTTP。`);
  }
  return url;
};

const isTrustedQwenDownloadHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return TRUSTED_QWEN_DOWNLOAD_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
};

const validatePresentationDownloadUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol === 'https:') return url;
  if (
    url.protocol === 'http:' &&
    (['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      isTrustedQwenDownloadHost(url.hostname))
  ) {
    return url;
  }
  throw new Error('PPT 下载链接不是受信任的安全地址。');
};

const qwenDocModel = (): string =>
  process.env.CYRVIS_QWEN_DOC_MODEL?.trim() ||
  runtimeConfig.model ||
  DEFAULT_MODEL;

const qwenDocTimeoutMs = (): number => {
  const configured = Number(process.env.CYRVIS_QWEN_DOC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 30_000
    ? Math.min(configured, 30 * 60_000)
    : DEFAULT_TIMEOUT_MS;
};

const requireText = (value: string, fallback = ''): string =>
  value.trim() || fallback;

const buildSourceDocument = (input: QwenDocPresentationInput): string => {
  if (input.sourceFileId?.trim()) {
    return `fileid://${input.sourceFileId.trim()}`;
  }
  const supplied = input.content?.trim();
  if (supplied) {
    if (supplied.length > MAX_SOURCE_CONTENT_CHARS) {
      throw new Error(
        `PPT 源文本超过 ${MAX_SOURCE_CONTENT_CHARS} 字符；请改用文件内容或缩短文本。`,
      );
    }
    return supplied;
  }
  return [
    `文档标题：${input.title}`,
    input.subtitle ? `副标题：${input.subtitle}` : '',
    '请基于标题和副标题设计一份结构完整、信息密度适中、可直接展示的演示文稿。',
    input.audience ? `目标受众：${input.audience}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const buildPptPrompt = (input: QwenDocPresentationInput): string => {
  const pageCount =
    typeof input.pageCount === 'number' && Number.isFinite(input.pageCount)
      ? Math.max(3, Math.min(30, Math.floor(input.pageCount)))
      : 10;
  return [
    `请生成一份 ${pageCount} 页左右的中文 PPT。`,
    '页面需要有清晰层级、事实一致、避免重复，并在结尾包含总结页。',
    input.audience ? `面向受众：${input.audience}。` : '',
  ]
    .filter(Boolean)
    .join('');
};

const extractSsePayloads = (
  buffer: string,
  flush = false,
): { events: string[]; remainder: string } => {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = flush ? '' : blocks.pop() || '';
  const events = blocks
    .flatMap((block) => block.split('\n'))
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  return { events, remainder };
};

const contentFromPayload = (
  payload: unknown,
): {
  content: string;
  reasoning: string;
} => {
  if (!payload || typeof payload !== 'object') {
    return { content: '', reasoning: '' };
  }
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const output =
    record.output && typeof record.output === 'object'
      ? (record.output as Record<string, unknown>)
      : null;
  const outputChoices =
    output && Array.isArray(output.choices) ? output.choices : [];
  const allChoices = [...choices, ...outputChoices];
  let content = '';
  let reasoning = '';
  for (const value of allChoices) {
    if (!value || typeof value !== 'object') continue;
    const choice = value as Record<string, unknown>;
    const delta =
      choice.delta && typeof choice.delta === 'object'
        ? (choice.delta as Record<string, unknown>)
        : null;
    const message =
      choice.message && typeof choice.message === 'object'
        ? (choice.message as Record<string, unknown>)
        : null;
    for (const part of [delta, message, choice]) {
      if (!part) continue;
      if (typeof part.content === 'string') content += part.content;
      if (typeof part.reasoning_content === 'string') {
        reasoning += part.reasoning_content;
      }
    }
  }
  if (!content && typeof record.content === 'string') {
    content = record.content;
  }
  if (!reasoning && typeof record.reasoning_content === 'string') {
    reasoning = record.reasoning_content;
  }
  return { content, reasoning };
};

export const consumeQwenDocStream = async (
  stream: ReadableStream<Uint8Array>,
  onProgress?: QwenDocProgressHandler,
): Promise<QwenDocStreamResult> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let reportedPlan = false;
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      }
      const parsed = extractSsePayloads(buffer, done);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        if (event === '[DONE]') continue;
        try {
          const part = contentFromPayload(JSON.parse(event));
          content += part.content;
          reasoning += part.reasoning;
          if (!reportedPlan && part.reasoning.trim()) {
            reportedPlan = true;
            onProgress?.('正在规划演示结构。', 28);
          }
        } catch {
          // Ignore keepalive or non-JSON SSE events.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { content, reasoning };
};

const extractDownloadUrl = (content: string): URL => {
  const trimmed = content
    .trim()
    .replace(/^```(?:markdown|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidates = [...trimmed.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)].map(
    (match) => match[0].replace(/[),.;!?，。；！？]+$/g, ''),
  );
  if (/^https?:\/\//i.test(trimmed) && !candidates.includes(trimmed)) {
    candidates.unshift(trimmed);
  }
  if (!candidates.length) {
    throw new Error('qwen-doc-turbo 没有返回 PPT 下载链接。');
  }
  const preferred =
    candidates.find((candidate) => {
      try {
        return /\.pptx?$/i.test(new URL(candidate).pathname);
      } catch {
        return false;
      }
    }) || candidates[0];
  return validatePresentationDownloadUrl(preferred);
};

class QwenDocHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QwenDocHttpError';
  }
}

const shouldTryNextApiKey = (error: unknown): boolean =>
  error instanceof QwenDocHttpError && [401, 403, 429].includes(error.status);

const responseError = async (response: Response): Promise<string> => {
  const requestId =
    response.headers.get('x-request-id') ||
    response.headers.get('x-dashscope-request-id');
  let detail = '';
  try {
    detail = (await response.text()).trim().slice(0, 2_000);
  } catch {
    // Ignore unreadable error bodies.
  }
  return [
    `qwen-doc-turbo 返回 ${response.status} ${response.statusText}`.trim(),
    detail,
    requestId ? `request-id=${requestId}` : '',
  ]
    .filter(Boolean)
    .join('；');
};

const downloadPresentation = async (
  downloadUrl: URL,
  targetPath: string,
): Promise<number> => {
  const secureUrl = new URL(downloadUrl);
  if (
    secureUrl.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '::1'].includes(secureUrl.hostname) &&
    isTrustedQwenDownloadHost(secureUrl.hostname)
  ) {
    secureUrl.protocol = 'https:';
  }
  const response = await fetch(secureUrl, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(await responseError(response));
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PRESENTATION_BYTES
  ) {
    throw new Error('qwen-doc-turbo 返回的 PPT 超过 50 MB。');
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length) throw new Error('qwen-doc-turbo 返回了空 PPT。');
  if (content.length > MAX_PRESENTATION_BYTES) {
    throw new Error('qwen-doc-turbo 返回的 PPT 超过 50 MB。');
  }
  if (content[0] !== 0x50 || content[1] !== 0x4b) {
    throw new Error('qwen-doc-turbo 下载内容不是有效的 PPTX ZIP 文件。');
  }
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.qwen-doc.tmp`;
  try {
    await fs.writeFile(temporary, content);
    await fs.copyFile(temporary, targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return content.length;
};

export const createQwenDocPresentation = async (
  input: QwenDocPresentationInput,
  onProgress?: QwenDocProgressHandler,
): Promise<QwenDocPresentationResult> => {
  const apiKeyCandidates = qwenDocApiKeyCandidates();
  if (!apiKeyCandidates.length) {
    throw new Error(
      '未配置 CYRVIS_QWEN_DOC_API_KEY、DASHSCOPE_API_KEY 或 QWEN_API_KEY。',
    );
  }
  const mode = input.mode === 'creative' ? 'creative' : 'general';
  if (input.sourceFileId?.trim() && mode !== 'creative') {
    throw new Error('qwen-doc-turbo 的文件 ID 输入只支持 creative 模式。');
  }
  const templateId =
    mode === 'general'
      ? requireText(input.templateId || '', 'summary_01')
      : null;
  if (templateId && !PPT_TEMPLATE_IDS.has(templateId)) {
    throw new Error(
      `不支持的 PPT 模板 ${templateId}；可选：${[...PPT_TEMPLATE_IDS].join(
        ', ',
      )}。`,
    );
  }
  const baseUrl = qwenDocBaseUrl();
  const endpoint = new URL(
    `${baseUrl.toString().replace(/\/$/, '')}/chat/completions`,
  );
  const model = qwenDocModel();
  const sourceDocument = buildSourceDocument(input);
  const skill = {
    type: 'ppt',
    mode,
    ...(templateId ? { template_id: templateId } : {}),
  };
  onProgress?.('正在整理演示内容。', 8);
  const requestBody = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a helpful presentation-generation assistant.',
      },
      {
        role: 'system',
        content: sourceDocument,
      },
      {
        role: 'user',
        content: buildPptPrompt(input),
      },
    ],
    skill: [skill],
    stream: true,
    stream_options: { include_usage: true },
  });
  const attemptedSources: string[] = [];
  let lastError: unknown;

  for (let index = 0; index < apiKeyCandidates.length; index += 1) {
    const candidate = apiKeyCandidates[index];
    attemptedSources.push(candidate.source);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${candidate.value}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: requestBody,
        signal: AbortSignal.timeout(qwenDocTimeoutMs()),
      });
      if (!response.ok) {
        throw new QwenDocHttpError(
          await responseError(response),
          response.status,
        );
      }
      onProgress?.('正在设计页面和版式。', 55);
      if (!response.body) {
        throw new Error('qwen-doc-turbo 没有返回流式响应体。');
      }
      const streamed = await consumeQwenDocStream(response.body, onProgress);
      onProgress?.('正在下载并校验演示文稿。', 82);
      const downloadUrl = extractDownloadUrl(streamed.content);
      const bytes = await downloadPresentation(downloadUrl, input.path);
      onProgress?.('正在完成文件检查。', 96);
      return {
        provider: 'qwen-doc-turbo',
        model,
        mode,
        templateId,
        downloadHost: downloadUrl.host,
        bytes,
      };
    } catch (error) {
      lastError = error;
      const nextCandidate = apiKeyCandidates[index + 1];
      if (!nextCandidate || !shouldTryNextApiKey(error)) {
        break;
      }
      onProgress?.('正在换一种方式继续制作。', 18);
    }
  }

  if (attemptedSources.length > 1 && lastError instanceof Error) {
    throw new Error(
      `Qwen Doc 凭据尝试失败（${attemptedSources.join(', ')}）：${lastError.message}`.slice(
        0,
        2_000,
      ),
    );
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('qwen-doc-turbo PPT generation failed.');
};
