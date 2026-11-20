/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GUIAgentData,
  UITarsModelVersion,
  StatusEnum,
  ShareVersion,
  ErrorStatusEnum,
  GUIAgentError,
  Message,
} from '@ui-tars/shared/types';
import { IMAGE_PLACEHOLDER, MAX_LOOP_COUNT } from '@ui-tars/shared/constants';
import asyncRetry from 'async-retry';
import { Jimp } from 'jimp';
import { v4 as uuidv4 } from 'uuid';

import { setContext } from './context/useContext';
import { Operator, GUIAgentConfig, InvokeParams } from './types';
import { UITarsModel } from './Model';
import { BaseGUIAgent } from './base';
import {
  getSummary,
  processVlmParams,
  replaceBase64Prefix,
  toVlmModelFormat,
} from './utils';
import {
  INTERNAL_ACTION_SPACES_ENUM,
  MAX_SNAPSHOT_ERR_CNT,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_TEMPLATE,
} from './constants';
import { InternalServerError } from 'openai';

// A batch executes without a fresh screenshot between actions. Give the target
// UI a moment to settle (focus after click, text before Enter) so the next
// action does not race the previous one.
const BATCH_ACTION_DELAY_MS = 200;

const abortError = (): Error => {
  const error = new Error('Request was aborted.') as Error & {
    bail?: boolean;
  };
  error.name = 'AbortError';
  // Stop retrying immediately; an aborted action must not wait or retry.
  error.bail = true;
  return error;
};

const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const raceWithAbort = <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export class GUIAgent<T extends Operator> extends BaseGUIAgent<
  GUIAgentConfig<T>
> {
  private readonly operator: T;
  private readonly model: InstanceType<typeof UITarsModel>;
  private readonly logger: NonNullable<GUIAgentConfig<T>['logger']>;
  private uiTarsVersion?: UITarsModelVersion;
  private systemPrompt: string;

  private isPaused = false;
  private resumePromise: Promise<void> | null = null;
  private resolveResume: (() => void) | null = null;
  private isStopped = false;

  constructor(config: GUIAgentConfig<T>) {
    super(config);
    this.operator = config.operator;

    this.model =
      config.model instanceof UITarsModel
        ? config.model
        : new UITarsModel(config.model);
    this.logger = config.logger || console;
    this.uiTarsVersion = config.uiTarsVersion;
    this.systemPrompt = config.systemPrompt || this.buildSystemPrompt();
  }

  async run(
    instruction: string,
    historyMessages?: Message[],
    remoteModelHdrs?: Record<string, string>,
  ) {
    const { operator, model, logger } = this;
    const {
      signal,
      onData,
      onError,
      retry = {},
      maxLoopCount = MAX_LOOP_COUNT,
    } = this.config;

    const currentTime = Date.now();
    const data: GUIAgentData = {
      version: ShareVersion.V1,
      systemPrompt: this.systemPrompt,
      instruction,
      modelName: this.model.modelName,
      status: StatusEnum.INIT,
      logTime: currentTime,
      conversations: [
        {
          from: 'human',
          value: instruction,
          timing: {
            start: currentTime,
            end: currentTime,
            cost: 0,
          },
        },
      ],
    };

    // inject guiAgent config for operator to get
    setContext(
      Object.assign(this.config, {
        logger: this.logger,
        systemPrompt: this.systemPrompt,
        factors: this.model.factors,
        model: this.model,
      }),
    );

    logger.info('[GUIAgent] run', {
      modelVersion: this.uiTarsVersion,
      model: this.model.modelName,
    });

    let loopCnt = 0;
    let snapshotErrCnt = 0;
    let totalTokens = 0;
    let totalTime = 0;
    let previousResponseId: string | undefined;

    // start running agent
    data.status = StatusEnum.RUNNING;
    await onData?.({ data: { ...data, conversations: [] } });

    // Generate session id with UUID
    const sessionId = this.generateSessionId();

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        logger.info('[GUIAgent] loopCnt:', loopCnt);
        // check pause status
        if (this.isPaused && this.resumePromise) {
          data.status = StatusEnum.PAUSE;
          await onData?.({
            data: {
              ...data,
              conversations: [],
            },
          });
          await this.resumePromise;
          data.status = StatusEnum.RUNNING;
          await onData?.({
            data: {
              ...data,
              conversations: [],
            },
          });
        }

        if (
          this.isStopped ||
          (data.status !== StatusEnum.RUNNING &&
            data.status !== StatusEnum.PAUSE) ||
          signal?.aborted
        ) {
          // check if stop or aborted
          signal?.aborted && (data.status = StatusEnum.USER_STOPPED);
          break;
        }

        if (loopCnt >= maxLoopCount) {
          Object.assign(data, {
            status: StatusEnum.ERROR,
            error: this.guiAgentErrorParser(
              ErrorStatusEnum.REACH_MAXLOOP_ERROR,
            ),
          });
          break;
        }

        if (snapshotErrCnt >= MAX_SNAPSHOT_ERR_CNT) {
          Object.assign(data, {
            status: StatusEnum.ERROR,
            error: this.guiAgentErrorParser(
              ErrorStatusEnum.SCREENSHOT_RETRY_ERROR,
            ),
          });
          break;
        }

        loopCnt += 1;
        const start = Date.now();

        const snapshot = await asyncRetry(() => operator.screenshot(), {
          retries: retry?.screenshot?.maxRetries ?? 0,
          minTimeout: 5000,
          onRetry: retry?.screenshot?.onRetry,
        });

        const { width, height, mime } = await Jimp.fromBuffer(
          Buffer.from(replaceBase64Prefix(snapshot.base64), 'base64'),
        ).catch((e) => {
          logger.error('[GUIAgent] screenshot error', e);
          return {
            width: null,
            height: null,
            mime: '',
          };
        });

        const isValidImage = !!(snapshot?.base64 && width && height);

        if (!isValidImage) {
          loopCnt -= 1;
          snapshotErrCnt += 1;
          await sleepWithAbort(1000, signal);
          continue;
        }

        let end = Date.now();

        if (isValidImage) {
          data.conversations.push({
            from: 'human',
            value: IMAGE_PLACEHOLDER,
            screenshotBase64: snapshot.base64,
            screenshotContext: {
              size: {
                width,
                height,
              },
              mime,
              scaleFactor: snapshot.scaleFactor,
            },
            timing: {
              start,
              end,
              cost: end - start,
            },
          });
          await onData?.({
            data: {
              ...data,
              conversations: data.conversations.slice(-1),
            },
          });
        }

        // conversations -> messages, images
        const modelFormat = toVlmModelFormat({
          historyMessages: historyMessages || [],
          conversations: data.conversations,
          systemPrompt: data.systemPrompt,
        });
        // sliding images window to vlm model
        const vlmParams: InvokeParams = {
          ...processVlmParams(modelFormat.conversations, modelFormat.images),
          screenContext: {
            width,
            height,
          },
          scaleFactor: snapshot.scaleFactor,
          uiTarsVersion: this.uiTarsVersion,
          headers: {
            ...remoteModelHdrs,
            'X-Session-Id': sessionId,
          },
          previousResponseId,
        };
        const {
          prediction,
          parsedPredictions,
          costTime,
          costTokens,
          responseId,
        } = await asyncRetry(
          async (bail) => {
            try {
              const result = await model.invoke(vlmParams);
              return result;
            } catch (error: unknown) {
              if (
                error instanceof Error &&
                (error?.name === 'APIUserAbortError' ||
                  error?.message?.includes('aborted'))
              ) {
                bail(error as unknown as Error);
                return {
                  prediction: '',
                  parsedPredictions: [],
                };
              }

              const status = (error as { status?: number })?.status;
              const code = (error as { code?: string })?.code || '';
              if (
                [400, 401, 403, 404, 422].includes(status || 0) ||
                (status === 429 && /quota|balance|arrear/i.test(code))
              ) {
                bail(error as Error);
                return { prediction: '', parsedPredictions: [] };
              }

              // A transient attempt failure is not the task's terminal state.
              // Otherwise a successful retry still ends the loop after its action.
              throw error;
            }
          },
          {
            retries: retry?.model?.maxRetries ?? 0,
            minTimeout: retry?.model?.minTimeoutMs ?? 1000 * 30,
            maxTimeout: retry?.model?.maxTimeoutMs ?? Infinity,
            onRetry: retry?.model?.onRetry,
          },
        );

        // responseId shouldn't be assigned to null or undefined
        if (responseId) {
          previousResponseId = responseId;
        }

        totalTokens += costTokens || 0;
        totalTime += costTime || 0;

        logger.info(
          `[GUIAgent] consumes: >>> costTime: ${costTime}, costTokens: ${costTokens} <<<`,
        );
        logger.info('[GUIAgent] Response:', prediction);
        logger.info(
          '[GUIAgent] Parsed Predictions:',
          JSON.stringify(parsedPredictions),
        );
        logger.info('[GUIAgent] action batch', {
          count: parsedPredictions.length,
          types: parsedPredictions.map((item) => item.action_type),
        });

        if (!prediction) {
          logger.error('[GUIAgent] Response Empty:', prediction);
          continue;
        }

        const predictionSummary = getSummary(prediction);

        end = Date.now();
        data.conversations.push({
          from: 'gpt',
          value: predictionSummary,
          timing: {
            start,
            end,
            cost: end - start,
          },
          screenshotContext: {
            size: {
              width,
              height,
            },
            scaleFactor: snapshot.scaleFactor,
          },
          predictionParsed: parsedPredictions,
        });
        await onData?.({
          data: {
            ...data,
            conversations: data.conversations.slice(-1),
          },
        });

        // start execute action
        const batchAllowed = process.env.CYRVIS_ACTION_BATCHING === '1';
        const executablePredictions = batchAllowed
          ? parsedPredictions
          : parsedPredictions.slice(0, 1);
        if (parsedPredictions.length > 1 && !batchAllowed) {
          logger.warn(
            '[GUIAgent] action batching disabled; executing first action only',
            {
              parsed: parsedPredictions.length,
            },
          );
        }
        let actionIndex = 0;
        for (const parsedPrediction of executablePredictions) {
          if (actionIndex > 0 && executablePredictions.length > 1) {
            await sleepWithAbort(BATCH_ACTION_DELAY_MS, signal);
          }
          actionIndex += 1;
          const actionType = parsedPrediction.action_type;

          logger.info('[GUIAgent] Action:', actionType);

          // handle internal action spaces
          if (actionType === INTERNAL_ACTION_SPACES_ENUM.ERROR_ENV) {
            Object.assign(data, {
              status: StatusEnum.ERROR,
              error: this.guiAgentErrorParser(
                ErrorStatusEnum.ENVIRONMENT_ERROR,
              ),
            });
            break;
          } else if (actionType === INTERNAL_ACTION_SPACES_ENUM.MAX_LOOP) {
            Object.assign(data, {
              status: StatusEnum.ERROR,
              error: this.guiAgentErrorParser(
                ErrorStatusEnum.REACH_MAXLOOP_ERROR,
              ),
            });
            break;
          }

          // Pause can arrive while the model is still thinking. Do not
          // execute the stale action after the user asked to stop; the next
          // loop will wait on resumePromise and re-plan from a fresh frame.
          if (!signal?.aborted && !this.isStopped && !this.isPaused) {
            logger.info(
              '[GUIAgent] Action Inputs:',
              parsedPrediction.action_inputs,
              parsedPrediction.action_type,
            );
            // TODO: pass executeOutput to onData
            const executeOutput = await asyncRetry(
              () => {
                if (signal?.aborted || this.isStopped) {
                  throw abortError();
                }
                return raceWithAbort(
                  operator.execute({
                    prediction,
                    parsedPrediction,
                    screenWidth: width,
                    screenHeight: height,
                    scaleFactor: snapshot.scaleFactor,
                    factors: this.model.factors,
                    signal,
                  }),
                  signal,
                );
              },
              {
                retries: retry?.execute?.maxRetries ?? 0,
                minTimeout: 5000,
                onRetry: retry?.execute?.onRetry,
              },
            ).catch((e) => {
              if (
                signal?.aborted ||
                this.isStopped ||
                (e instanceof Error && e.name === 'AbortError')
              ) {
                throw e;
              }
              logger.error('[GUIAgent] execute error', e);
              Object.assign(data, {
                status: StatusEnum.ERROR,
                error: this.guiAgentErrorParser(
                  ErrorStatusEnum.EXECUTE_RETRY_ERROR,
                  e,
                ),
              });
            });

            if (executeOutput && executeOutput?.status) {
              data.status = executeOutput.status;
            }
          }

          // Action types must break the loop after operator execution:
          if (actionType === INTERNAL_ACTION_SPACES_ENUM.CALL_USER) {
            data.status = StatusEnum.CALL_USER;
            break;
          } else if (actionType === INTERNAL_ACTION_SPACES_ENUM.FINISHED) {
            data.status = StatusEnum.END;
            break;
          }
        }

        if (this.config.loopIntervalInMs && this.config.loopIntervalInMs > 0) {
          logger.info(
            `[GUIAgent] sleep for ${this.config.loopIntervalInMs}ms before next loop`,
          );
          await sleepWithAbort(this.config.loopIntervalInMs, signal);
          logger.info(
            `[GUIAgent] sleep for ${this.config.loopIntervalInMs}ms before next loop done`,
          );
        }
      }
    } catch (error) {
      logger.error('[GUIAgent] Catch error', error);
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message?.includes('aborted'))
      ) {
        logger.info('[GUIAgent] Catch: request was aborted');
        data.status = StatusEnum.USER_STOPPED;
        return;
      }

      data.status = StatusEnum.ERROR;
      data.error = this.guiAgentErrorParser(
        ErrorStatusEnum.UNKNOWN_ERROR,
        error as Error,
      );

      // We only use OnError callback to dispatch error information to caller,
      // and we will not throw error to the caller.
      // throw error;
    } finally {
      logger.info('[GUIAgent] Finally: status', data.status);

      this.model?.reset();

      if (data.status === StatusEnum.USER_STOPPED) {
        await operator.execute({
          prediction: '',
          parsedPrediction: {
            action_inputs: {},
            reflection: null,
            action_type: 'user_stop',
            thought: '',
          },
          screenWidth: 0,
          screenHeight: 0,
          scaleFactor: 1,
          factors: [0, 0],
        });
      }

      await onData?.({ data: { ...data, conversations: [] } });

      if (data.status === StatusEnum.ERROR) {
        onError?.({
          data,
          error:
            data.error ||
            new GUIAgentError(
              ErrorStatusEnum.UNKNOWN_ERROR,
              'Unknown error occurred',
            ),
        });
      }

      logger.info(
        `[GUIAgent] >>> totalTokens: ${totalTokens}, totalTime: ${totalTime}, loopCnt: ${loopCnt} <<<`,
      );
    }
  }

  public pause() {
    this.isPaused = true;
    this.resumePromise = new Promise((resolve) => {
      this.resolveResume = resolve;
    });
  }

  public resume() {
    if (this.resolveResume) {
      this.resolveResume();
      this.resumePromise = null;
      this.resolveResume = null;
    }
    this.isPaused = false;
  }

  public stop() {
    this.isStopped = true;
  }

  private buildSystemPrompt() {
    const actionSpaces = (this.operator.constructor as typeof Operator)?.MANUAL
      ?.ACTION_SPACES;

    return actionSpaces == null || actionSpaces.length === 0
      ? SYSTEM_PROMPT
      : SYSTEM_PROMPT_TEMPLATE.replace(
          '{{action_spaces_holder}}',
          actionSpaces.join('\n'),
        );
  }

  private guiAgentErrorParser(
    type: ErrorStatusEnum,
    error?: Error,
  ): GUIAgentError {
    this.logger.error('[GUIAgent] guiAgentErrorParser:', error);

    let parseError = null;

    if (error instanceof InternalServerError) {
      this.logger.error(
        '[GUIAgent] guiAgentErrorParser instanceof InternalServerError.',
      );
      parseError = new GUIAgentError(
        ErrorStatusEnum.MODEL_SERVICE_ERROR,
        error.message,
        error.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.REACH_MAXLOOP_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.REACH_MAXLOOP_ERROR,
        `Has reached max loop count: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.SCREENSHOT_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.SCREENSHOT_RETRY_ERROR,
        `Too many screenshot failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.INVOKE_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.INVOKE_RETRY_ERROR,
        `Too many model invoke failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.EXECUTE_RETRY_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.EXECUTE_RETRY_ERROR,
        `Too many action execute failures: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError && type === ErrorStatusEnum.ENVIRONMENT_ERROR) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.ENVIRONMENT_ERROR,
        `The environment error occurred when parsing the action: ${error?.message || ''}`,
        error?.stack,
      );
    }

    if (!parseError) {
      parseError = new GUIAgentError(
        ErrorStatusEnum.UNKNOWN_ERROR,
        error instanceof Error ? error.message : 'Unknown error occurred',
        error instanceof Error ? error.stack || 'null' : 'null',
      );
    }

    if (!parseError.stack) {
      // Avoid guiAgentErrorParser it self in stack trace
      Error.captureStackTrace(parseError, this.guiAgentErrorParser);
    }

    return parseError;
  }

  private generateSessionId(): string {
    return uuidv4();
  }
}
