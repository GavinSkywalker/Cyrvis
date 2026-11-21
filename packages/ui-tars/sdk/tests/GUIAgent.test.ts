/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GUIAgent } from '../src/GUIAgent';
import { Operator } from '../src/types';
import { Jimp } from 'jimp';
import { useContext } from '../src/context/useContext';
import { GUIAgentData, StatusEnum } from '../src';
import { IMAGE_PLACEHOLDER } from '@ui-tars/shared/constants';
import { UITarsModel } from '../src/Model';
import { mockOpenAIResponse } from './testKits/index';
import { DEFAULT_FACTORS } from '../src/constants';

const getContext = vi.fn();
vi.mock('openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('openai')>()),
  default: vi.fn(),
}));

const image = new Jimp({
  width: 1920,
  height: 1080,
  color: 0xffffffff,
});
class MockOperator extends Operator {
  screenshot = vi.fn().mockImplementation(async () => {
    const buffer = await image.getBuffer('image/png');

    return {
      base64: buffer.toString('base64'),
      width: 1920,
      height: 1080,
      scaleFactor: 1,
    };
  });

  execute = vi.fn().mockImplementation(async () => {
    getContext(useContext());
  });
}

describe('GUIAgent', () => {
  afterEach(() => {
    getContext.mockRestore();
    vi.unstubAllEnvs();
  });
  it('continues executing after a transient request succeeds on a bounded retry', async () => {
    const model = new UITarsModel({ apiKey: 'test-key', model: 'test-model' });
    const invoke = vi
      .spyOn(model, 'invoke')
      .mockRejectedValueOnce(new Error('Request timed out.'))
      .mockResolvedValueOnce({
        prediction: 'Action: click()',
        parsedPredictions: [
          {
            action_type: 'click',
            action_inputs: { start_box: '[0.5,0.5,0.5,0.5]' },
          },
        ],
      })
      .mockResolvedValueOnce({
        prediction: 'Action: finished()',
        parsedPredictions: [{ action_type: 'finished', action_inputs: {} }],
      });
    const onError = vi.fn();
    const statuses: StatusEnum[] = [];
    const operator = new MockOperator();
    const logger = {
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const agent = new GUIAgent({
      model,
      operator,
      logger,
      onError,
      retry: { model: { maxRetries: 1, minTimeoutMs: 1, maxTimeoutMs: 1 } },
      onData: ({ data }) => {
        statuses.push(data.status);
      },
    });
    await agent.run('click then finish');
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(statuses).not.toContain(StatusEnum.ERROR);
    expect(statuses.at(-1)).toBe(StatusEnum.END);
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('test-key');
  });

  it.each([
    { status: 403, code: 'Forbidden.AgentPlanDeductNotEnabled' },
    { status: 429, code: 'QuotaExceeded.AgentPlanQuotaExceeded' },
  ])(
    'does not retry a permanent model rejection ($code)',
    async ({ status, code }) => {
      const model = new UITarsModel({
        apiKey: 'test-key',
        model: 'test-model',
      });
      const invoke = vi
        .spyOn(model, 'invoke')
        .mockRejectedValue(Object.assign(new Error(code), { status, code }));
      const operator = new MockOperator();
      const onError = vi.fn();
      const agent = new GUIAgent({
        model,
        operator,
        onError,
        retry: { model: { maxRetries: 5, minTimeoutMs: 1, maxTimeoutMs: 1 } },
      });
      await agent.run('click');
      expect(invoke).toHaveBeenCalledOnce();
      expect(operator.execute).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
    },
  );

  it('fails after its retry budget without executing any action', async () => {
    const model = new UITarsModel({ apiKey: 'test-key', model: 'test-model' });
    const invoke = vi
      .spyOn(model, 'invoke')
      .mockRejectedValue(new Error('Request timed out.'));
    const operator = new MockOperator();
    const onError = vi.fn();
    const agent = new GUIAgent({
      model,
      operator,
      onError,
      retry: { model: { maxRetries: 1, minTimeoutMs: 1, maxTimeoutMs: 1 } },
    });
    await agent.run('click');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(operator.execute).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not repeat a timed-out stale screenshot when timeout retries are disabled', async () => {
    const model = new UITarsModel({ apiKey: 'test-key', model: 'test-model' });
    const invoke = vi
      .spyOn(model, 'invoke')
      .mockRejectedValue(new Error('Request timed out.'));
    const operator = new MockOperator();
    const onError = vi.fn();
    const agent = new GUIAgent({
      model,
      operator,
      onError,
      retry: {
        model: {
          maxRetries: 1,
          retryOnTimeout: false,
          minTimeoutMs: 1,
          maxTimeoutMs: 1,
        },
      },
    });
    await agent.run('click');
    expect(invoke).toHaveBeenCalledOnce();
    expect(operator.execute).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('normal run', async () => {
    mockOpenAIResponse([
      "Thought: Click on the search bar at the top of the screen\nAction: click(start_box='(72,646)')",
      'Thought: finished.\nAction: finished()',
    ]);
    const modelConfig = {
      baseURL: 'http://localhost:3000/v1',
      apiKey: 'test-key',
      model: 'ui-tars',
    };
    const operator = new MockOperator();

    const dataEvents: GUIAgentData[] = [];
    const onData = vi.fn().mockImplementation(({ data: newData }) => {
      dataEvents.push(newData);
    });
    const onError = vi.fn();

    const agent = new GUIAgent({
      model: modelConfig,
      operator,
      onData,
      onError,
    });

    await agent.run('click the button');

    expect(getContext.mock.calls[0][0]).toMatchObject({
      model: {
        modelConfig,
      },
    });

    expect(operator.execute).toBeCalledTimes(2);
    expect(operator.execute.mock.calls[0][0]).toEqual({
      factors: DEFAULT_FACTORS,
      parsedPrediction: {
        action_inputs: {
          start_box: '[0.072,0.646,0.072,0.646]',
          start_coords: [138.24, 697.68],
        },
        action_type: 'click',
        reflection: null,
        thought: 'Click on the search bar at the top of the screen',
      },
      prediction:
        "Thought: Click on the search bar at the top of the screen\nAction: click(start_box='(72,646)')",
      scaleFactor: 1,
      screenHeight: 1080,
      screenWidth: 1920,
    });

    expect(dataEvents).toEqual([
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'gpt',
            value:
              "Thought: Click on the search bar at the top of the screen\nAction: click(start_box='(72,646)')",
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'gpt',
            value: 'Thought: finished.\nAction: finished()',
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.END,
        conversations: [],
      }),
    ]);

    expect(onError).not.toHaveBeenCalled();
  });

  it('executes batched actions from one response without a new screenshot', async () => {
    vi.stubEnv('CYRVIS_ACTION_BATCHING', '1');
    mockOpenAIResponse([
      "Thought: Type and submit in one batch\nAction: type(content='hello')\n\nhotkey(key='enter')",
      'Thought: finished.\nAction: finished()',
    ]);
    const modelConfig = {
      baseURL: 'http://localhost:3000/v1',
      apiKey: 'test-key',
      model: 'ui-tars',
    };
    const operator = new MockOperator();
    const agent = new GUIAgent({
      model: modelConfig,
      operator,
      loopIntervalInMs: 0,
    });

    await agent.run('type hello and press enter');

    // One screenshot per loop: the two actions in the first response must not
    // trigger an extra screenshot.
    expect(operator.screenshot).toBeCalledTimes(2);
    expect(operator.execute).toBeCalledTimes(3);
    expect(
      operator.execute.mock.calls.map(
        ([params]) => params.parsedPrediction.action_type,
      ),
    ).toEqual(['type', 'hotkey', 'finished']);
    expect(operator.execute.mock.calls[0][0].prediction).toBe(
      operator.execute.mock.calls[1][0].prediction,
    );
  });

  it('executes only the first action when batching is disabled', async () => {
    mockOpenAIResponse([
      "Thought: Type and submit\nAction: type(content='hello')\n\nhotkey(key='enter')",
      'Thought: finished.\nAction: finished()',
    ]);
    const modelConfig = {
      baseURL: 'http://localhost:3000/v1',
      apiKey: 'test-key',
      model: 'ui-tars',
    };
    const operator = new MockOperator();
    const agent = new GUIAgent({
      model: modelConfig,
      operator,
      loopIntervalInMs: 0,
    });

    await agent.run('type hello');

    expect(operator.execute).toBeCalledTimes(2);
    expect(
      operator.execute.mock.calls.map(
        ([params]) => params.parsedPrediction.action_type,
      ),
    ).toEqual(['type', 'finished']);
  });

  it('custom UITarsModel run', async () => {
    const operator = new MockOperator();
    const getContextCustom = vi.fn();

    class CustomUITarsModel extends UITarsModel {
      constructor(modelConfig: { model: string }) {
        super(modelConfig);
      }
      protected override async invokeModelProvider() {
        getContextCustom(useContext());

        return {
          prediction: 'Thought: finished.\nAction: finished()',
        };
      }
    }

    const dataEvents: GUIAgentData[] = [];
    const onData = vi.fn().mockImplementation(({ data: newData }) => {
      dataEvents.push(newData);
    });
    const onError = vi.fn();
    const model = new CustomUITarsModel({
      model: 'ui-tars-sft',
    });

    const agent = new GUIAgent({
      model,
      operator,
      onData,
      onError,
    });

    await agent.run('click the button');

    expect(getContextCustom.mock.calls[0][0]).toMatchObject({
      model: {
        modelConfig: {
          model: 'ui-tars-sft',
        },
      },
    });

    expect(operator.execute).toHaveBeenCalled();

    expect(dataEvents).toEqual([
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        modelName: 'ui-tars-sft',
        conversations: [],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        modelName: 'ui-tars-sft',
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'gpt',
            value: 'Thought: finished.\nAction: finished()',
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.END,
        conversations: [],
      }),
    ]);

    expect(onError).not.toHaveBeenCalled();
  });

  it('should handle abort correctly', async () => {
    const abortController = new AbortController();
    class MockAbortOperator extends Operator {
      screenshot = vi.fn().mockImplementation(async () => {
        abortController.abort();
        const buffer = await image.getBuffer('image/png');

        return {
          base64: buffer.toString('base64'),
          width: 1920,
          height: 1080,
          scaleFactor: 1,
        };
      });

      execute = vi.fn().mockImplementation(async () => {
        return;
      });
    }

    const promise: Promise<string> = new Promise((resolve) => {
      setTimeout(
        () =>
          resolve(
            "Thought: Click on the search bar\nAction: click(start_box='(72,646)')",
          ),
        10000,
      );
    });
    // mock 5s
    mockOpenAIResponse([promise]);

    const operator = new MockAbortOperator();
    const dataEvents: GUIAgentData[] = [];

    const onData = vi.fn().mockImplementation(({ data }) => {
      dataEvents.push(data);
    });
    const onError = vi.fn();

    const agent = new GUIAgent({
      model: {
        baseURL: 'http://localhost:3000/v1',
        apiKey: 'test-key',
        model: 'ui-tars',
      },
      operator,
      signal: abortController.signal,
      onData,
      onError,
    });

    await agent.run('click the button');

    expect(operator.screenshot).toBeCalledTimes(1);
    expect(operator.execute).toHaveBeenCalled();

    expect(dataEvents).toEqual([
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        conversations: [],
      }),
    ]);
  });

  it('Custom Action Spaces in Custom Operator', async () => {
    mockOpenAIResponse([
      "Thought: Click on the search bar at the top of the screen\nAction: CLICK(start_box='(72,646)')",
      'Thought: finished.\nAction: END()',
    ]);
    const modelConfig = {
      baseURL: 'http://localhost:3000/v1',
      apiKey: 'test-key',
      model: 'ui-tars',
    };
    class CustomActionSpacesOperator extends Operator {
      static MANUAL = {
        ACTION_SPACES: [
          `CLICK(start_box='[x1, y1, x2, y2]')`,
          `END() # Submit the task regardless of whether it succeeds or fails.`,
        ],
      };
      screenshot = vi.fn().mockImplementation(async () => {
        const buffer = await image.getBuffer('image/png');

        return {
          base64: buffer.toString('base64'),
          width: 1920,
          height: 1080,
          scaleFactor: 1,
        };
      });

      execute = vi.fn().mockImplementation(async (params) => {
        getContext(useContext());
        const { parsedPrediction } = params;
        if (parsedPrediction?.action_type === 'END') {
          return {
            status: StatusEnum.END,
          };
        }
      });
    }

    const operator = new CustomActionSpacesOperator();

    const dataEvents: GUIAgentData[] = [];
    const onData = vi.fn().mockImplementation(({ data: newData }) => {
      dataEvents.push(newData);
    });
    const onError = vi.fn();

    const agent = new GUIAgent({
      model: modelConfig,
      systemPrompt: `
      You are a helpful assistant.
      You can only use the following actions:
      ## Action Spaces
      ${CustomActionSpacesOperator.MANUAL.ACTION_SPACES.join('\n')}
      `,
      operator,
      onData,
      onError,
    });

    await agent.run('click the button');

    expect(getContext.mock.calls[0][0]).toMatchObject({
      model: {
        modelConfig,
      },
    });

    expect(operator.execute).toBeCalledTimes(2);
    expect(operator.execute.mock.calls[0][0]).toEqual({
      factors: DEFAULT_FACTORS,
      parsedPrediction: {
        action_inputs: {
          start_box: '[0.072,0.646,0.072,0.646]',
          start_coords: [138.24, 697.68],
        },
        action_type: 'CLICK',
        reflection: null,
        thought: 'Click on the search bar at the top of the screen',
      },
      prediction:
        "Thought: Click on the search bar at the top of the screen\nAction: CLICK(start_box='(72,646)')",
      scaleFactor: 1,
      screenHeight: 1080,
      screenWidth: 1920,
    });

    expect(dataEvents).toEqual([
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'gpt',
            value:
              "Thought: Click on the search bar at the top of the screen\nAction: CLICK(start_box='(72,646)')",
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: (await image.getBuffer('image/png')).toString(
              'base64',
            ),
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.RUNNING,
        conversations: [
          expect.objectContaining({
            from: 'gpt',
            value: 'Thought: finished.\nAction: END()',
          }),
        ],
      }),
      expect.objectContaining({
        status: StatusEnum.END,
        conversations: [],
      }),
    ]);

    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts an in-flight operator action immediately', async () => {
    const abortController = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    class SlowOperator extends Operator {
      screenshot = vi.fn().mockImplementation(async () => {
        const buffer = await image.getBuffer('image/png');
        return {
          base64: buffer.toString('base64'),
          width: 1920,
          height: 1080,
          scaleFactor: 1,
        };
      });

      execute = vi
        .fn()
        .mockImplementation(
          async ({
            parsedPrediction,
            signal,
          }: {
            parsedPrediction: { action_type: string };
            signal?: AbortSignal;
          }) => {
            if (parsedPrediction.action_type === 'user_stop') return;
            markStarted();
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                const error = new Error('Request was aborted.');
                error.name = 'AbortError';
                reject(error);
              };
              if (signal?.aborted) {
                onAbort();
                return;
              }
              signal?.addEventListener('abort', onAbort, { once: true });
            });
          },
        );
    }

    const model = new UITarsModel({ apiKey: 'test-key', model: 'test-model' });
    vi.spyOn(model, 'invoke').mockResolvedValue({
      prediction: 'Action: click()',
      parsedPredictions: [
        {
          action_type: 'click',
          action_inputs: { start_box: '[0.5,0.5,0.5,0.5]' },
        },
      ],
    });
    const statuses: StatusEnum[] = [];
    const operator = new SlowOperator();
    const agent = new GUIAgent({
      model,
      operator,
      signal: abortController.signal,
      retry: { execute: { maxRetries: 1 } },
      logger: {
        info: vi.fn(),
        log: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      onData: ({ data }) => statuses.push(data.status),
    });

    const run = agent.run('click');
    await started;
    const stoppedAt = Date.now();
    abortController.abort();
    await run;

    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(statuses.at(-1)).toBe(StatusEnum.USER_STOPPED);
  });
});
