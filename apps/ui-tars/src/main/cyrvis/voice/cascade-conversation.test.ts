import { describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: openAiMock.create,
      },
    };
  },
}));

vi.mock('@main/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/store/setting', () => ({
  SettingStore: {
    getStore: () => ({
      conversationApiKey: 'test-key',
      conversationBaseUrl: 'https://example.test/v1',
      conversationModelName: 'test-model',
    }),
  },
}));

import { CascadeConversationClient } from './cascade-conversation';
import { shouldDisableThinking } from './cascade-policy';

describe('cascade conversation routing', () => {
  it('disables DeepSeek thinking for lower first-token latency', () => {
    expect(
      shouldDisableThinking('https://api.deepseek.com/v1', 'deepseek-chat'),
    ).toBe(true);
    expect(
      shouldDisableThinking(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen-plus',
      ),
    ).toBe(false);
  });

  it('keeps file tool results in history for follow-up edits', async () => {
    openAiMock.create.mockReset();
    const filePath = 'C:\\Users\\actual-user\\Desktop\\note.txt';
    let completion = 0;
    openAiMock.create.mockImplementation(async () => {
      const current = completion++;
      const chunks =
        current === 0
          ? [
              {
                choices: [
                  {
                    delta: {
                      content: '',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-open-file',
                          type: 'function',
                          function: {
                            name: 'cyrvis_fs_open',
                            arguments: JSON.stringify({ path: filePath }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ]
          : [
              {
                choices: [
                  {
                    delta: {
                      content:
                        current === 1 ? '已经打开文件。' : '可以继续修改。',
                    },
                  },
                ],
              },
            ];
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    });

    const conversation = new CascadeConversationClient([]);
    const signal = new AbortController().signal;
    await conversation.ask('打开这个文件', {
      signal,
      callbacks: {
        onToolCall: (call) => {
          conversation.sendToolResult(
            call.callId,
            JSON.stringify({ ok: true, status: 'completed', path: filePath }),
          );
        },
      },
    });
    await conversation.ask('把第一行改掉', { signal, callbacks: {} });

    const followUpMessages = openAiMock.create.mock.calls[2]?.[0]?.messages;
    expect(
      followUpMessages.some(
        (message: { role: string }) => message.role === 'tool',
      ),
    ).toBe(true);
    const toolResult = followUpMessages.find(
      (message: { role: string }) => message.role === 'tool',
    ) as { content: string };
    expect(JSON.parse(toolResult.content)).toMatchObject({
      path: filePath,
    });
  });

  it('acknowledges a background tool immediately without waiting for another model round', async () => {
    openAiMock.create.mockReset();
    openAiMock.create.mockImplementation(async () =>
      (async function* () {
        yield {
          choices: [
            {
              delta: {
                content: '',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-long',
                    type: 'function',
                    function: {
                      name: 'create_presentation',
                      arguments: '{"title":"测试"}',
                    },
                  },
                ],
              },
            },
          ],
        };
      })(),
    );
    const conversation = new CascadeConversationClient([]);
    const result = await conversation.ask('制作测试 PPT', {
      signal: new AbortController().signal,
      callbacks: {
        onToolCall: (call) => {
          conversation.sendToolResult(
            call.callId,
            JSON.stringify({
              ok: true,
              status: 'running',
              background: true,
              startMessage: '好，PPT 制作已开始，完成后我会向你汇报。',
            }),
          );
        },
      },
    });

    expect(result.text).toBe('好，PPT 制作已开始，完成后我会向你汇报。');
    expect(openAiMock.create).toHaveBeenCalledTimes(1);
  });

  it('uses the latest dynamic tool definitions on each turn', async () => {
    openAiMock.create.mockReset();
    openAiMock.create.mockImplementation(async () =>
      (async function* () {
        yield {
          choices: [{ delta: { content: '好的。' } }],
        };
      })(),
    );
    const conversation = new CascadeConversationClient([]);
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'cyrvis_capability_search',
          description: 'Search dynamic capabilities.',
          parameters: {
            type: 'object' as const,
            properties: { query: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
    ];

    conversation.setTools(tools);
    await conversation.ask('找一下系统里的能力', {
      signal: new AbortController().signal,
      callbacks: {},
    });

    expect(openAiMock.create.mock.calls[0]?.[0]?.tools).toEqual(tools);
  });
});
