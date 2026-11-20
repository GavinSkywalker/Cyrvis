/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { IntakeEngine } from './engine';
import type { IntakeSlotSpec } from './types';

const slots = (): IntakeSlotSpec[] => [
  {
    key: 'destination',
    label: '目的地',
    question: '去哪个城市？',
    kind: 'text',
    priority: 1,
    parse: (text) => text.split(/[，,、\s]/)[0] || undefined,
  },
  {
    key: 'origin',
    label: '出发地',
    question: '从哪出发？',
    kind: 'text',
    priority: 2,
    parse: (text, context) => {
      const parts = text.split(/[，,、\s]/).filter(Boolean);
      return context.expected ? parts[0] : parts[1];
    },
  },
  {
    key: 'date',
    label: '日期',
    question: '哪天出发？',
    kind: 'date',
    priority: 3,
    parse: (text) => text.match(/\d{1,2}月\d{1,2}日/)?.[0],
  },
];

describe('IntakeEngine', () => {
  it('asks one field at a time and fills several answers in one turn', () => {
    const engine = new IntakeEngine();
    engine.start('travel', '订机票', slots());
    const first = engine.next();
    expect(first?.slot.key).toBe('destination');

    const turn = engine.updateFromText('三亚，北京，11月27日');
    expect(turn?.filled).toEqual(['destination', 'origin', 'date']);
    expect(turn?.ready).toBe(true);
    expect(turn?.nextSlot).toBeNull();
  });

  it('does not repeat a question that has already been answered', () => {
    const engine = new IntakeEngine();
    engine.start('travel', '订机票', slots(), { destination: '三亚' });
    const first = engine.next();
    expect(first?.slot.key).toBe('origin');

    const turn = engine.updateFromText('北京');
    expect(turn?.filled).toEqual(['origin']);
    expect(engine.next()?.slot.key).toBe('date');
  });

  it('uses defaults when the user says it is up to the assistant', () => {
    const engine = new IntakeEngine();
    engine.start(
      'travel',
      '订机票',
      [
        ...slots(),
        {
          key: 'days',
          label: '天数',
          question: '待几天？',
          kind: 'duration',
          priority: 4,
          defaultValue: '3',
        },
      ],
      { destination: '三亚', origin: '北京', date: '2026-11-27' },
    );
    engine.next();

    const turn = engine.updateFromText('随便');
    expect(turn?.ready).toBe(true);
    expect(turn?.session.answers.days).toBe('3');
  });

  it('resolves ordinal choices from the last presented options', () => {
    const engine = new IntakeEngine();
    engine.start('travel', '选目的地', [
      {
        key: 'destination',
        label: '目的地',
        question: '选哪个？',
        kind: 'choice',
        priority: 1,
      },
    ]);
    engine.setOptions([
      { id: 'sanya', label: '三亚' },
      { id: 'xiamen', label: '厦门' },
    ]);
    engine.next();

    const turn = engine.updateFromText('第二个');
    expect(turn?.ready).toBe(true);
    expect(turn?.session.answers.destination).toBe('xiamen');
  });
});
