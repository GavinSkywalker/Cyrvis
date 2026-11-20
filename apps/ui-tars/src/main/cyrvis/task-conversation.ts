/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ControllerEvent, TaskSnapshot } from './types';

export interface TaskConversationCoordinatorOptions {
  speak: (text: string) => void;
  /** Drop a queued proactive line that has not been sent yet. */
  clearSpeech?: () => void;
  getStatus: () => TaskSnapshot;
  startAckDelayMs?: number;
  progressIntervalMs?: number;
  stalledCooldownMs?: number;
  now?: () => number;
}

export class TaskConversationCoordinator {
  private startAckTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOutputAt = 0;
  private lastProgressAt = 0;
  private lastStalledAt = -Infinity;
  private lastStalledStep: number | null = null;
  private lastStep = 0;
  private lastSpokenNode = '';
  // Progress/stall lines are only valid while this task is active. A queued
  // "still processing" line must never speak after done/failed/cancelled.
  private terminal = false;
  private readonly startAckDelayMs: number;
  private readonly progressIntervalMs: number;
  private readonly stalledCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TaskConversationCoordinatorOptions) {
    this.startAckDelayMs = options.startAckDelayMs ?? 700;
    this.progressIntervalMs = options.progressIntervalMs ?? 10_000;
    this.stalledCooldownMs = options.stalledCooldownMs ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  noteAssistantOutput(): void {
    this.lastOutputAt = this.now();
    this.clearStartAck();
  }

  onEvent(event: ControllerEvent): void {
    const eventAt = this.now();
    switch (event.type) {
      case 'task_started': {
        this.clearStartAck();
        this.terminal = false;
        this.lastStep = 0;
        this.lastStalledAt = -Infinity;
        this.lastStalledStep = null;
        this.lastProgressAt = -Infinity;
        this.lastSpokenNode = '';
        this.startAckTimer = setTimeout(() => {
          this.startAckTimer = null;
          if (this.lastOutputAt >= eventAt) {
            return;
          }
          this.options.speak('任务已开始。');
        }, this.startAckDelayMs);
        break;
      }
      case 'step_update':
        if (
          !this.terminal &&
          this.options.getStatus().status === 'executing' &&
          event.step > this.lastStep &&
          eventAt - this.lastProgressAt >= this.progressIntervalMs
        ) {
          const summary = (event.summary || '').trim();
          this.lastStep = event.step;
          this.lastProgressAt = eventAt;
          if (summary && summary === this.lastSpokenNode) {
            break;
          }
          this.lastSpokenNode = summary;
          this.options.speak(
            summary ? `任务节点：${summary}` : '任务继续处理中。',
          );
        }
        break;
      case 'task_stalled':
        if (
          !this.terminal &&
          this.options.getStatus().status === 'executing' &&
          event.step !== this.lastStalledStep &&
          eventAt - this.lastStalledAt >= this.stalledCooldownMs
        ) {
          this.lastStalledAt = eventAt;
          this.lastStalledStep = event.step;
          const summary = this.options.getStatus().lastSummary?.trim();
          this.options.speak(
            summary
              ? `任务仍在处理，步骤 ${event.step}：${summary}。`
              : `任务仍在处理，当前步骤 ${event.step}。`,
          );
        }
        break;
      case 'task_needs_user':
        this.clearStartAck();
        this.options.speak(event.question || '这里需要你确认一下。');
        break;
      case 'task_paused':
        this.options.clearSpeech?.();
        this.options.speak('任务已暂停。');
        break;
      case 'task_resumed':
        this.options.speak('任务继续执行。');
        break;
      case 'task_done':
        this.terminal = true;
        this.clearStartAck();
        this.options.clearSpeech?.();
        this.options.speak('任务已经完成。');
        break;
      case 'task_failed':
        this.terminal = true;
        this.clearStartAck();
        this.options.clearSpeech?.();
        this.options.speak(`任务失败：${event.error}`);
        break;
      case 'task_cancelled':
        this.terminal = true;
        this.clearStartAck();
        this.options.clearSpeech?.();
        this.options.speak('任务已取消。');
        break;
      default:
        break;
    }
  }

  describeStatus(): string {
    const task = this.options.getStatus();
    switch (task.status) {
      case 'starting':
        return '任务正在启动，还没有进入第一个执行步骤。';
      case 'executing':
        return task.lastSummary
          ? `任务正在执行，当前节点：${task.lastSummary}。`
          : '任务正在执行。';
      case 'paused':
        return '任务已暂停。';
      case 'cancelling':
        return '任务正在取消。';
      case 'done':
        return '任务已经完成。';
      case 'failed':
        return `任务失败：${task.error || '未知错误'}`;
      case 'cancelled':
        return '任务已取消。';
      default:
        return '当前没有正在执行的任务。';
    }
  }

  /** Hard stop: invalidate queued progress/stall lines immediately. */
  markStopped(): void {
    this.terminal = true;
    this.clearStartAck();
    this.options.clearSpeech?.();
  }

  reset(): void {
    this.clearStartAck();
    this.lastOutputAt = 0;
    this.lastProgressAt = 0;
    this.lastStalledAt = -Infinity;
    this.lastStalledStep = null;
    this.lastStep = 0;
    this.lastSpokenNode = '';
  }

  dispose(): void {
    this.clearStartAck();
  }

  private clearStartAck(): void {
    if (this.startAckTimer) {
      clearTimeout(this.startAckTimer);
      this.startAckTimer = null;
    }
  }
}
