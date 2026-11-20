/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type IntakeSessionStatus = 'collecting' | 'ready' | 'done' | 'cancelled';

export type IntakeSlotKind = 'text' | 'date' | 'duration' | 'number' | 'choice';

export interface IntakeChoice {
  id: string;
  label: string;
  aliases?: string[];
}

export interface IntakeParseContext {
  /** True when this slot is the question the assistant just asked. */
  expected: boolean;
  session: IntakeSession;
  text: string;
}

export interface IntakeSlotSpec {
  key: string;
  label: string;
  question: string;
  kind: IntakeSlotKind;
  /** Required slots block execution. Defaults to true. */
  required?: boolean;
  /** Set false for optional fields that should never be proactively asked. */
  ask?: boolean;
  /** Lower numbers are asked first. */
  priority: number;
  /** Used when the user says “随便/你定/都可以”. */
  defaultValue?: string;
  choices?: IntakeChoice[];
  parse?: (text: string, context: IntakeParseContext) => unknown;
}

export interface IntakeSession {
  id: string;
  domain: string;
  goal: string;
  slots: IntakeSlotSpec[];
  answers: Record<string, unknown>;
  status: IntakeSessionStatus;
  lastAskedKey: string | null;
  askedCount: Record<string, number>;
  lastAskedAt: number | null;
  options?: IntakeChoice[];
}

export interface IntakeQuestion {
  session: IntakeSession;
  slot: IntakeSlotSpec;
  question: string;
}

export interface IntakeTurn {
  session: IntakeSession;
  filled: string[];
  ready: boolean;
  nextSlot: IntakeSlotSpec | null;
  question: string | null;
}
