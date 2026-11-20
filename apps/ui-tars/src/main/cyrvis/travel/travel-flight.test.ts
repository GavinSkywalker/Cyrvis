/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import {
  compareFlights,
  formatFlightComparison,
  isTravelFlightIntent,
  parseTravelDate,
  parseTravelDestination,
  parseTravelDurationDays,
  parseTravelOrigin,
} from './travel-flight';

describe('travel flight slots', () => {
  it('parses destination, origin, date and duration from natural language', () => {
    expect(parseTravelDestination('我要买一张去三亚的机票')).toBe('三亚');
    expect(parseTravelDestination('就厦门吧', true)).toBe('厦门');
    expect(parseTravelOrigin('从北京出发')).toBe('北京');
    expect(parseTravelOrigin('北京', true)).toBe('北京');

    const now = new Date('2026-11-20T10:00:00');
    expect(parseTravelDate('下周五', now)).toBe('2026-11-27');
    expect(parseTravelDate('11月27日', now)).toBe('2026-11-27');
    expect(parseTravelDate('明天', now)).toBe('2026-11-21');
    expect(parseTravelDurationDays('待五天')).toBe(5);
    expect(parseTravelDurationDays('3天两晚')).toBe(3);
    expect(parseTravelDurationDays('一周')).toBe(7);
  });

  it('distinguishes a concrete flight purchase from a generic search', () => {
    expect(isTravelFlightIntent('我要买一张去三亚的机票')).toBe(true);
    expect(isTravelFlightIntent('三亚机票多少钱')).toBe(true);
    expect(isTravelFlightIntent('我要去巴黎的机票')).toBe(false);
  });
});

describe('flight comparison', () => {
  const input = {
    origin: '北京',
    destination: '三亚',
    departDate: '2026-11-27',
    durationDays: 5,
  };

  it('returns five deterministic offers with a best choice', () => {
    const first = compareFlights(input);
    const second = compareFlights(input);

    expect(first.offers).toHaveLength(5);
    expect(first.best).not.toBeNull();
    expect(second.best?.provider).toBe(first.best?.provider);
    expect(second.best?.totalPrice).toBe(first.best?.totalPrice);
    expect(first.returnDate).toBe('2026-12-02');
    expect(first.best?.url).toMatch(/^https?:\/\//);
    expect(first.ranked[0].score).toBeGreaterThanOrEqual(first.ranked[1].score);
  });

  it('speaks the platform count, top three and the recommendation', () => {
    const comparison = compareFlights(input);
    const speech = formatFlightComparison(comparison);

    expect(speech).toContain('我比了 5 个平台');
    expect(speech).toContain(comparison.best!.provider);
    expect(speech).toContain('我建议选');
    expect(speech).toContain('往返5天');
  });
});
