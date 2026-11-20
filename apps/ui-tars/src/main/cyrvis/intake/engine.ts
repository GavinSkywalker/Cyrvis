/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';

import type {
  IntakeChoice,
  IntakeQuestion,
  IntakeSession,
  IntakeSlotSpec,
  IntakeTurn,
} from './types';

const ORDINALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
};

const UNSURE =
  /^(?:随便|你定|都可以|都行|无所谓|不确定|不知道|看你的?)[。！？!?，,\s]*$/;

const clean = (value: unknown): string => {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};

const slotRequired = (slot: IntakeSlotSpec): boolean => slot.required !== false;

const formatValue = (slot: IntakeSlotSpec, value: unknown): string => {
  if (value == null) return '';
  const choice = slot.choices?.find((item) => item.id === String(value));
  return choice?.label || String(value);
};

const slotComplete = (
  session: IntakeSession,
  slot: IntakeSlotSpec,
): boolean => {
  const value = session.answers[slot.key];
  return value !== undefined && value !== null && clean(value) !== '';
};

/**
 * Generic, domain-agnostic slot filling for proactive conversations.
 *
 * A domain only supplies slot specs and optional parsers. The same engine can
 * drive flight booking, shopping, appointment scheduling, document requests or
 * any other workflow where a few missing facts block execution.
 */
export class IntakeEngine {
  private session: IntakeSession | null = null;

  getSession(): IntakeSession | null {
    return this.session;
  }

  start(
    domain: string,
    goal: string,
    slots: IntakeSlotSpec[],
    initialAnswers: Record<string, unknown> = {},
  ): IntakeSession {
    const answers: Record<string, unknown> = {};
    for (const slot of slots) {
      const value = initialAnswers[slot.key];
      if (value !== undefined && value !== null && clean(value) !== '') {
        answers[slot.key] = value;
      }
    }

    this.session = {
      id: `${domain}-${randomUUID()}`,
      domain,
      goal: goal.trim(),
      slots: [...slots].sort((a, b) => a.priority - b.priority),
      answers,
      status: 'collecting',
      lastAskedKey: null,
      askedCount: {},
      lastAskedAt: null,
    };
    this.refreshStatus();
    return this.session;
  }

  cancel(): void {
    if (!this.session) return;
    this.session.status = 'cancelled';
    this.session = null;
  }

  complete(): void {
    if (!this.session) return;
    this.session.status = 'done';
    this.session = null;
  }

  setOptions(options: IntakeChoice[]): IntakeSession | null {
    if (!this.session) return null;
    this.session.options = options;
    return this.session;
  }

  updateAnswers(answers: Record<string, unknown>): IntakeSession | null {
    if (!this.session) return null;
    for (const slot of this.session.slots) {
      const value = answers[slot.key];
      if (value !== undefined && value !== null && clean(value) !== '') {
        this.session.answers[slot.key] = value;
      }
    }
    this.refreshStatus();
    return this.session;
  }

  updateFromText(text: string): IntakeTurn | null {
    if (!this.session) return null;
    const session = this.session;
    const raw = clean(text);
    if (!raw) {
      return {
        session,
        filled: [],
        ready: session.status === 'ready',
        nextSlot: null,
        question: null,
      };
    }

    if (UNSURE.test(raw)) {
      const filled: string[] = [];
      for (const slot of session.slots) {
        if (slotComplete(session, slot)) continue;
        if (slot.defaultValue !== undefined) {
          session.answers[slot.key] = slot.defaultValue;
          filled.push(slot.key);
        }
      }
      this.refreshStatus();
      if (session.status === 'ready') {
        return {
          session,
          filled,
          ready: true,
          nextSlot: null,
          question: null,
        };
      }
      const next = this.next();
      return {
        session,
        filled,
        ready: false,
        nextSlot: next?.slot || null,
        question: next?.question || null,
      };
    }

    const filled: string[] = [];
    let usedPlainText = false;
    for (const slot of session.slots) {
      if (slotComplete(session, slot)) continue;
      const expected = session.lastAskedKey === slot.key;

      if (slot.kind === 'choice' && session.options?.length) {
        const choice = this.resolveChoice(session.options, raw);
        if (choice) {
          session.answers[slot.key] = choice.id;
          filled.push(slot.key);
          continue;
        }
      }

      const parsed = slot.parse?.(raw, { expected, session, text: raw });
      if (parsed !== undefined && parsed !== null && clean(parsed) !== '') {
        session.answers[slot.key] = parsed;
        filled.push(slot.key);
        continue;
      }

      if (!slot.parse && expected && slot.kind === 'text' && !usedPlainText) {
        if (raw.length <= 120) {
          session.answers[slot.key] = raw;
          filled.push(slot.key);
          usedPlainText = true;
        }
      }
    }

    if (filled.length === 0) {
      return {
        session,
        filled,
        ready: false,
        nextSlot: null,
        question: null,
      };
    }

    this.refreshStatus();
    if (session.status === 'ready') {
      return {
        session,
        filled,
        ready: true,
        nextSlot: null,
        question: null,
      };
    }

    const next = this.next();
    return {
      session,
      filled,
      ready: false,
      nextSlot: next?.slot || null,
      question: next?.question || null,
    };
  }

  next(): IntakeQuestion | null {
    if (!this.session) return null;
    const next = this.nextUnfilled();
    if (!next) {
      this.refreshStatus();
      return null;
    }
    this.session.lastAskedKey = next.key;
    this.session.lastAskedAt = Date.now();
    this.session.askedCount[next.key] =
      (this.session.askedCount[next.key] || 0) + 1;
    return {
      session: this.session,
      slot: next,
      question: next.question,
    };
  }

  getSummary(): string {
    if (!this.session) return '';
    return this.session.slots
      .filter((slot) => slotComplete(this.session!, slot))
      .map(
        (slot) =>
          `${slot.label}：${formatValue(slot, this.session!.answers[slot.key])}`,
      )
      .join('；');
  }

  getMissingLabels(): string[] {
    if (!this.session) return [];
    return this.session.slots
      .filter(
        (slot) => slotRequired(slot) && !slotComplete(this.session!, slot),
      )
      .map((slot) => slot.label);
  }

  getCurrentSlot(): IntakeSlotSpec | null {
    if (!this.session?.lastAskedKey) return null;
    return (
      this.session.slots.find(
        (slot) => slot.key === this.session!.lastAskedKey,
      ) || null
    );
  }

  private refreshStatus(): void {
    if (!this.session) return;
    const missing = this.session.slots.some(
      (slot) => slotRequired(slot) && !slotComplete(this.session!, slot),
    );
    this.session.status = missing ? 'collecting' : 'ready';
  }

  private nextUnfilled(): IntakeSlotSpec | null {
    if (!this.session) return null;
    const pending = this.session.slots.filter(
      (slot) => !slotComplete(this.session!, slot),
    );
    return (
      pending.find((slot) => slotRequired(slot)) ||
      pending.find((slot) => slot.ask !== false) ||
      null
    );
  }

  private resolveChoice(
    options: IntakeChoice[],
    text: string,
  ): IntakeChoice | null {
    const compact = text.replace(/[，。！？!?、,\s]/g, '');
    const ordinal =
      compact.match(/(?:第)?([一二两三四五六七八九十]|\d{1,2})个?/) ||
      compact.match(/^([一二两三四五六七八九十]|\d{1,2})$/);
    if (ordinal) {
      const index = ORDINALS[ordinal[1]];
      if (index && options[index - 1]) return options[index - 1];
    }
    return (
      options.find((option) => {
        const labels = [option.label, option.id, ...(option.aliases || [])];
        return labels.some((label) => {
          const candidate = label.replace(/\s+/g, '');
          return (
            candidate.length > 0 &&
            (compact === candidate ||
              compact.includes(candidate) ||
              candidate.includes(compact))
          );
        });
      }) || null
    );
  }
}
