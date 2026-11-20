import { describe, expect, it } from 'vitest';

import { UserTimelineStore } from './user-timeline';

describe('UserTimelineStore', () => {
  it('merges stable activity and starts a new episode after context changes', () => {
    let now = 1_000;
    let id = 0;
    const timeline = new UserTimelineStore({
      now: () => now,
      idFactory: () => `episode-${++id}`,
    });
    const first = timeline.observe({
      activity: 'coding',
      activeApplication: 'Code',
      activeWindow: 'main.ts',
      focusedControl: 'Editor',
      confidence: 0.8,
      evidence: ['system.app'],
    });
    now += 1_000;
    const merged = timeline.observe({
      activity: 'coding',
      activeApplication: 'Code',
      activeWindow: 'main.ts',
      focusedControl: 'Editor',
      confidence: 0.9,
      evidence: ['system.app', 'system.focus'],
    });
    expect(merged.id).toBe(first.id);
    expect(merged.confidence).toBe(0.9);

    now += 1_000;
    const second = timeline.observe({
      activity: 'browsing',
      activeApplication: 'Chrome',
      activeWindow: 'Docs',
      focusedControl: null,
      confidence: 0.75,
      evidence: ['system.app'],
    });
    expect(second.id).not.toBe(first.id);
    expect(timeline.snapshot().episodes).toHaveLength(2);
    expect(timeline.snapshot().episodes[0].endedAt).toBe(now);
  });

  it('records acceptance feedback on the current episode', () => {
    const timeline = new UserTimelineStore();
    timeline.observe({
      activity: 'idle',
      activeApplication: null,
      activeWindow: null,
      focusedControl: null,
      confidence: 0.2,
      evidence: [],
    });
    expect(timeline.recordFeedback('accepted')).toBe(true);
    expect(timeline.snapshot().current?.feedback).toBe('accepted');
  });
});
