export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  type: string;
  windowId?: number;
  active?: boolean;
}

export interface BrowserCdpOptions {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  timeoutMs?: number;
}

export const resolveBrowserDebugBaseUrl = (override?: () => string): string => {
  const value = override?.() || process.env.CYRVIS_BROWSER_DEBUG_URL || '';
  const url = new URL(value || 'http://127.0.0.1:9222');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Browser debug URL must use http or https.');
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Browser debug URL must target a loopback host.');
  }
  return url.toString().replace(/\/+$/, '');
};

export const browserRequest = async (
  options: BrowserCdpOptions,
  endpoint: string,
  method = 'GET',
  signal?: AbortSignal,
): Promise<unknown> => {
  const fetchImpl = options.fetch || fetch;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(250, options.timeoutMs ?? 4_000),
  );
  timeout.unref?.();
  try {
    const response = await fetchImpl(
      `${resolveBrowserDebugBaseUrl(options.baseUrl)}${endpoint}`,
      { method, signal: controller.signal },
    );
    if (!response.ok) {
      throw new Error(`Browser debug endpoint returned ${response.status}.`);
    }
    const textBody = await response.text();
    if (!textBody) {
      return null;
    }
    try {
      return JSON.parse(textBody);
    } catch {
      return textBody;
    }
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
};

export const normalizeBrowserTabs = (value: unknown): BrowserTab[] =>
  (Array.isArray(value) ? value : [])
    .filter((tab): tab is BrowserTab =>
      Boolean(
        tab &&
          typeof tab === 'object' &&
          typeof (tab as BrowserTab).id === 'string' &&
          typeof (tab as BrowserTab).url === 'string',
      ),
    )
    .filter((tab) => tab.type === 'page')
    .map((tab) => ({
      id: tab.id,
      title: typeof tab.title === 'string' ? tab.title : tab.url,
      url: tab.url,
      type: tab.type,
      ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
      ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
    }));

const normalizeTabQuery = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const matchBrowserTabs = (
  tabs: BrowserTab[],
  query: string,
): BrowserTab[] => {
  const wanted = normalizeTabQuery(query);
  if (!wanted) return [];
  return tabs.filter((tab) => {
    const title = normalizeTabQuery(tab.title);
    const url = normalizeTabQuery(tab.url);
    return title.includes(wanted) || url.includes(wanted);
  });
};

export const listBrowserTabs = async (
  options: BrowserCdpOptions = {},
  signal?: AbortSignal,
): Promise<BrowserTab[]> => {
  const value = await browserRequest(options, '/json/list', 'GET', signal);
  if (!Array.isArray(value)) {
    throw new Error('Browser debug endpoint returned an invalid tab list.');
  }
  return normalizeBrowserTabs(value);
};

export const openBrowserTab = async (
  url: string,
  options: BrowserCdpOptions = {},
): Promise<unknown> =>
  browserRequest(options, `/json/new?${encodeURIComponent(url)}`, 'PUT');

export const activateBrowserTab = async (
  tabId: string,
  options: BrowserCdpOptions = {},
): Promise<void> => {
  await browserRequest(options, `/json/activate/${encodeURIComponent(tabId)}`);
};

export const closeBrowserTab = async (
  tabId: string,
  options: BrowserCdpOptions = {},
): Promise<void> => {
  await browserRequest(options, `/json/close/${encodeURIComponent(tabId)}`);
};

export const resolveBrowserTab = async (
  query: string,
  options: BrowserCdpOptions = {},
  signal?: AbortSignal,
): Promise<BrowserTab | null> => {
  const tabs = await listBrowserTabs(options, signal);
  const matches = matchBrowserTabs(tabs, query);
  if (matches.length > 1) {
    throw new Error(`Browser tab target is ambiguous: ${query}`);
  }
  return matches[0] || null;
};

export const waitForBrowserTabMissing = async (
  tabId: string,
  options: BrowserCdpOptions = {},
  timeoutMs = 2_000,
): Promise<boolean> => {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  let lastError: unknown;
  do {
    try {
      const tabs = await listBrowserTabs(options);
      if (!tabs.some((tab) => tab.id === tabId)) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  if (lastError) {
    throw lastError;
  }
  return false;
};
