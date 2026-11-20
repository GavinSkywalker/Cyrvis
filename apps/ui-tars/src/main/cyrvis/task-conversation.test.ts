/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskConversationCoordinator } from './task-conversation';
import type { TaskSnapshot } from './types';

const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  taskId: 'task-1',
  status: 'executing',
  instruction: '打开浏览器',
  source: 'voice',
  step: 2,
  lastSummary: '打开页面',
  error: null,
  startedAt: 1,
  endedAt: null,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TaskConversationCoordinator', () => {
  it('guarantees a task-start acknowledgment when the model stays silent', async () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot({ status: 'starting', step: 0 }),
    });

    coordinator.onEvent({
      type: 'task_started',
      taskId: 'task-1',
      instruction: '打开浏览器',
      source: 'voice',
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(spoken).toEqual(['任务已开始。']);
  });

  it('does not duplicate a model response that arrives before the start fallback', async () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot(),
    });
    coordinator.onEvent({
      type: 'task_started',
      taskId: 'task-1',
      instruction: '打开浏览器',
      source: 'voice',
    });
    coordinator.noteAssistantOutput();
    await vi.advanceTimersByTimeAsync(700);
    expect(spoken).toEqual([]);
  });

  it('always reports needs-user, completion, and failure events', () => {
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot(),
    });
    coordinator.onEvent({
      type: 'task_needs_user',
      taskId: 'task-1',
      question: '要使用哪个浏览器？',
    });
    coordinator.onEvent({
      type: 'task_done',
      taskId: 'task-1',
      summary: '已经打开浏览器。',
    });
    coordinator.onEvent({
      type: 'task_failed',
      taskId: 'task-1',
      error: '网络不可用',
    });
    expect(spoken).toEqual([
      '要使用哪个浏览器？',
      '任务已经完成。',
      '任务失败：网络不可用',
    ]);
  });

  it('announces a wait once per unchanged step and resets for a new task', () => {
    let now = 100_000;
    const spoken: string[] = [];
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      getStatus: () => snapshot({ step: 0 }),
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      coordinator.onEvent({ type: 'task_stalled', taskId: 'task-1', step: 0 });
      now += 20_000;
    }
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toBe('任务仍在处理，步骤 0：打开页面。');
    coordinator.onEvent({ type: 'task_stalled', taskId: 'task-1', step: 1 });
    expect(spoken).toHaveLength(2);
    expect(coordinator.describeStatus()).toContain('任务正在执行');
    coordinator.onEvent({
      type: 'task_started',
      taskId: 'task-2',
      instruction: '播放',
      source: 'voice',
    });
    coordinator.onEvent({ type: 'task_stalled', taskId: 'task-2', step: 0 });
    expect(spoken).toHaveLength(3);
    coordinator.dispose();
  });

  it('drops stale progress speech after a terminal status', () => {
    const spoken: string[] = [];
    const clearSpeech = vi.fn();
    let status: TaskSnapshot = snapshot({ status: 'executing' });
    const coordinator = new TaskConversationCoordinator({
      speak: (text) => spoken.push(text),
      clearSpeech,
      getStatus: () => status,
    });

    coordinator.onEvent({
      type: 'task_stalled',
      taskId: 'task-1',
      step: 2,
    });
    status = snapshot({ status: 'done', endedAt: 2 });
    coordinator.onEvent({
      type: 'task_done',
      taskId: 'task-1',
      summary: '已经完成。',
    });
    coordinator.onEvent({
      type: 'step_update',
      taskId: 'task-1',
      step: 3,
      summary: '迟到的进度',
      actionType: 'click',
    });
    coordinator.onEvent({
      type: 'task_stalled',
      taskId: 'task-1',
      step: 3,
    });

    expect(clearSpeech).toHaveBeenCalledTimes(1);
    expect(spoken).toEqual([
      '任务仍在处理，步骤 2：打开页面。',
      '任务已经完成。',
    ]);
  });

  it('describes the latest task status for spoken queries', () => {
    const coordinator = new TaskConversationCoordinator({
      speak: () => undefined,
      getStatus: () => snapshot(),
    });
    expect(coordinator.describeStatus()).toBe(
      '任务正在执行，当前节点：打开页面。',
    );
  });
});
