/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-session proactive nudges for an intake question.
 *
 * This is intentionally separate from the global follow-up service: asking a
 * missing slot is only useful while that specific intake is active, and must
 * never re-open the old "10s idle" chattiness.
 */
export class IntakeScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingKey: string | null = null;
  private readonly remindedKeys = new Set<string>();

  schedule(
    key: string,
    onReminder: () => void,
    canRemind: () => boolean,
    delayMs = 9_000,
  ): void {
    this.cancelPending();
    if (!key || this.remindedKeys.has(key)) return;
    this.pendingKey = key;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingKey = null;
      if (!canRemind()) return;
      this.remindedKeys.add(key);
      onReminder();
    }, delayMs);
    this.timer.unref?.();
  }

  cancelPending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingKey = null;
  }

  cancelAll(): void {
    this.cancelPending();
    this.remindedKeys.clear();
  }

  hasReminded(key: string): boolean {
    return this.remindedKeys.has(key);
  }

  getPendingKey(): string | null {
    return this.pendingKey;
  }
}
