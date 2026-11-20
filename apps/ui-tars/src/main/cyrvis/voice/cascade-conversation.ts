/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';

import { logger } from '@main/logger';
import { SettingStore } from '@main/store/setting';

import { cleanSpeechText, spokenCharacterCount } from './tars-speech';
import { shouldDisableThinking } from './cascade-policy';
import type { VoiceToolCallWithId } from './provider';
import { CYRVIS_VOICE_TOOLS, type QwenToolDefinition } from './tools';

type StreamingToolCall = {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type CascadeConversationCallbacks = {
  onAssistantDelta?: (text: string) => void;
  onSpeechDelta?: (text: string) => void;
  onToolCall?: (call: VoiceToolCallWithId) => void;
};

type RunResult = {
  text: string;
};

const BASE_INSTRUCTIONS = `You are CYRVIS, a Windows desktop voice assistant.

Answer ordinary conversation directly and concisely. Use the provided tools only
when the user explicitly asks to operate the computer, manage a task, inspect
status, or remember a durable fact. Never claim that a GUI task is complete until
the tool result or the task event confirms it.

Prefer tools whose names start with cyrvis_ for file, directory, app, window,
clipboard, system, process, and web operations. Use start_gui_task only when no
local cyrvis_ tool can complete the request, or when visual UI interaction is
actually required.

If a tool result has status "running" and background "true", the task has already
started. Immediately give the user a short spoken acknowledgement, state that you
will report when it finishes, and do not call the same tool again or claim it is
complete.

When the visible tool list does not contain an operation that may be a deeper
CYRVIS capability, call capability.search or capability.describe first, then
invoke it through capability.invoke. Do not route directly to GUI merely because
the specialized tool is hidden from the initial surface.

For file paths, prefer aliases such as Desktop, Downloads, Documents, Pictures,
Music, and Videos. Relative paths are resolved from the user's home directory,
not the project directory. Never infer a Windows username from the project
path or invent a C:\\Users\\... path. Explicit absolute paths may access any
area of the system; do not ask for another confirmation after the user has
already requested the operation.

For OS hardware, disks, processes, windows, installed software, or Steam games,
prefer system.snapshot, system.search_apps, software.list_installed,
steam.list_games, and software.launch before using GUI automation.

Every final answer is sent to text-to-speech. Return plain spoken language with
natural punctuation. Do not return Markdown, tables, code fences, emoji, raw
JSON, shell commands, or URLs unless the user explicitly asks to hear them.
Start with a complete, self-contained short sentence. Continue with essential
detail only when needed. If the user speaks Chinese, answer in Simplified
Chinese. Never reveal hidden chain-of-thought.`;

export class CascadeConversationClient {
  private context = '';
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private readonly pendingToolResults = new Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(private tools: QwenToolDefinition[] = CYRVIS_VOICE_TOOLS) {}

  setTools(tools: QwenToolDefinition[]): void {
    this.tools = tools;
  }

  setContext(context: string): void {
    this.context = context.trim();
  }

  sendToolResult(callId: string, output: string): void {
    const pending = this.pendingToolResults.get(callId);
    if (!pending) {
      logger.warn('[CascadeConversation] Tool result without pending call', {
        callId,
      });
      return;
    }
    this.pendingToolResults.delete(callId);
    pending.resolve(output);
  }

  cancelPendingToolResults(error: Error): void {
    for (const pending of this.pendingToolResults.values()) {
      pending.reject(error);
    }
    this.pendingToolResults.clear();
  }

  async ask(
    userText: string,
    options: {
      signal: AbortSignal;
      callbacks: CascadeConversationCallbacks;
    },
  ): Promise<RunResult> {
    const settings = SettingStore.getStore();
    const apiKey = settings.conversationApiKey?.trim() || '';
    const baseURL = settings.conversationBaseUrl?.trim();
    const model = settings.conversationModelName?.trim() || 'qwen-plus';
    if (!apiKey || !baseURL) {
      throw new Error(
        'Conversation LLM is not configured. Set CONVERSATION_BASE_URL and CONVERSATION_API_KEY.',
      );
    }

    const client = new OpenAI({ apiKey, baseURL });
    const requiredLanguage = /\p{Script=Han}/u.test(userText)
      ? 'Simplified Chinese'
      : 'the same language as the user';
    const tools = this
      .tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];

    const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [
        {
          role: 'system',
          content: `${BASE_INSTRUCTIONS}

Required reply language: ${requiredLanguage}.

Long-term memory and recent conversation context:
${this.context || '(empty)'}`,
        },
        ...this.history,
        { role: 'user', content: userText },
      ];

    try {
      const result = await this.runCompletion({
        client,
        baseURL,
        model,
        messages: requestMessages,
        tools,
        signal: options.signal,
        callbacks: options.callbacks,
      });

      if (result.text.trim()) {
        requestMessages.push({
          role: 'assistant',
          content: result.text.trim(),
        });
      }
      this.history = this.trimHistory(requestMessages.slice(1));
      return result;
    } catch (error) {
      this.cancelPendingToolResults(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private trimHistory(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const recent = messages.slice(-30);
    const firstUser = recent.findIndex((message) => message.role === 'user');
    return firstUser > 0 ? recent.slice(firstUser) : recent;
  }

  private async runCompletion({
    client,
    baseURL,
    model,
    messages,
    tools,
    signal,
    callbacks,
  }: {
    client: OpenAI;
    baseURL: string;
    model: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    signal: AbortSignal;
    callbacks: CascadeConversationCallbacks;
  }): Promise<RunResult> {
    const disableThinking = shouldDisableThinking(baseURL, model);
    const requestBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
      thinking?: { type: 'enabled' | 'disabled' };
    } = {
      model,
      temperature: 0.3,
      stream: true,
      ...(tools.length
        ? {
            tools,
            tool_choice: 'auto' as const,
          }
        : {}),
      ...(disableThinking
        ? {
            thinking: { type: 'disabled' as const },
          }
        : {}),
      messages,
    };

    const stream = await client.chat.completions.create(requestBody, {
      signal,
    });
    const toolCalls = new Map<number, StreamingToolCall>();
    let rawContent = '';
    let publishedSpeechText = '';

    for await (const chunk of stream) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        rawContent += delta.content;
        callbacks.onAssistantDelta?.(delta.content);

        const speechText = cleanSpeechText(rawContent);
        if (
          speechText &&
          spokenCharacterCount(speechText) >= 4 &&
          speechText !== publishedSpeechText &&
          (!publishedSpeechText || speechText.startsWith(publishedSpeechText))
        ) {
          const nextSpeechDelta = publishedSpeechText
            ? speechText.slice(publishedSpeechText.length)
            : speechText;
          publishedSpeechText = speechText;
          if (nextSpeechDelta) {
            callbacks.onSpeechDelta?.(nextSpeechDelta);
          }
        }
      }

      for (const toolCallDelta of delta?.tool_calls || []) {
        const index = toolCallDelta.index;
        const current = toolCalls.get(index) || {
          function: { name: '', arguments: '' },
        };
        if (toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.type === 'function') {
          current.type = 'function';
        }
        if (toolCallDelta.function?.name) {
          current.function.name += toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          current.function.arguments += toolCallDelta.function.arguments;
        }
        toolCalls.set(index, current);
      }
    }

    if (toolCalls.size) {
      const assistantToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call], index) => ({
          id: call.id || `call_${index}_${Date.now()}`,
          type: 'function' as const,
          function: call.function,
        }));
      messages.push({
        role: 'assistant',
        content: rawContent || null,
        tool_calls: assistantToolCalls,
      });

      const outputs = await Promise.all(
        assistantToolCalls.map(async (call) => {
          let args: Record<string, unknown> = {};
          if (call.function.arguments.trim()) {
            try {
              args = JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >;
            } catch {
              return {
                callId: call.id,
                output:
                  'ERROR: invalid tool arguments JSON. Retry with valid JSON.',
              };
            }
          }

          const output = await new Promise<string>((resolve, reject) => {
            this.pendingToolResults.set(call.id, { resolve, reject });
            callbacks.onToolCall?.({
              name: call.function.name,
              args,
              callId: call.id,
            } as VoiceToolCallWithId);
          });
          return { callId: call.id, output };
        }),
      );

      for (const output of outputs) {
        messages.push({
          role: 'tool',
          tool_call_id: output.callId,
          content: output.output,
        });
      }
      const backgroundMessages = outputs.map((output) => {
        try {
          const payload = JSON.parse(output.output) as {
            status?: unknown;
            background?: unknown;
            startMessage?: unknown;
          };
          return payload.status === 'running' &&
            payload.background === true &&
            typeof payload.startMessage === 'string'
            ? payload.startMessage.trim()
            : null;
        } catch {
          return null;
        }
      });
      if (
        backgroundMessages.length > 0 &&
        backgroundMessages.every((message): message is string =>
          Boolean(message),
        )
      ) {
        return { text: backgroundMessages.join(' ') };
      }

      return this.runCompletion({
        client,
        baseURL,
        model,
        messages,
        tools,
        signal,
        callbacks,
      });
    }

    const finalText = rawContent.trim();
    const finalSpeechText = cleanSpeechText(finalText);
    if (
      finalSpeechText &&
      finalSpeechText !== publishedSpeechText &&
      finalSpeechText.startsWith(publishedSpeechText)
    ) {
      const remainder = finalSpeechText.slice(publishedSpeechText.length);
      if (remainder) {
        callbacks.onSpeechDelta?.(remainder);
      }
    }
    return { text: finalText };
  }
}
