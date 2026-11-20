import { describe, expect, it } from 'vitest';
import type { RuntimeTask } from './types';
import {
  isUserVisibleCompanionTask,
  toCompanionTaskStatus,
  toCompanionTasks,
} from './companion-tasks';

function task(
  id: string,
  kind: RuntimeTask['kind'],
  status: RuntimeTask['status'],
  metadata: Record<string, unknown>,
  startedAt = 1,
): RuntimeTask {
  return {
    id,
    source: 'user-voice',
    kind,
    goal: id,
    payload: { metadata },
    lane: 'interactive',
    idempotencyKey: null,
    contract: {
      sideEffect: 'none',
      idempotent: false,
      retryable: false,
      maxAttempts: 1,
      retryBackoffMs: 500,
      timeoutMs: 0,
      resumePolicy: 'manual',
      verification: 'none',
    },
    checkpoint: null,
    progress: null,
    verification: {
      status: 'not_required',
      message: '',
      at: null,
    },
    priorityClass: 'user-now',
    priority: 0,
    preemptible: false,
    risk: 'low',
    resources: [],
    dependsOn: [],
    contextRevision: 0,
    createdAt: startedAt,
    updatedAt: startedAt,
    notBefore: null,
    deadline: null,
    startedAt,
    endedAt: null,
    status,
    attempts: 0,
    externalId: null,
    result: null,
    data: null,
    error: null,
  };
}

describe('companion task projection', () => {
  it('keeps internal fast tools out of the user-facing task stack', () => {
    const privateTools = [
      task('fast-tool', 'atomic', 'running', { fastTool: true }),
      task('hidden', 'observe', 'running', { userVisible: false }),
    ];
    expect(privateTools.map(isUserVisibleCompanionTask)).toEqual([
      false,
      false,
    ]);
    expect(toCompanionTasks(privateTools)).toEqual([]);
  });

  it('shows active GUI, coding and workflow tasks in newest-first order', () => {
    const tasks = toCompanionTasks([
      task('workflow', 'workflow', 'queued', {}, 200),
      task('coding', 'coding', 'running', {}, 300),
      task('gui', 'gui', 'waiting_confirmation', {}, 100),
      task('finished', 'coding', 'done', {}, 400),
    ]);
    expect(tasks.map(({ id, kind, status }) => ({ id, kind, status }))).toEqual(
      [
        { id: 'coding', kind: 'coding', status: 'running' },
        { id: 'workflow', kind: 'workflow', status: 'queued' },
        {
          id: 'gui',
          kind: 'gui',
          status: 'waiting_confirmation',
        },
      ],
    );
  });

  it('shows user-visible long-running fast tools with progress', () => {
    const longTask = task('ppt', 'atomic', 'running', {
      fastTool: true,
      userVisible: true,
    });
    longTask.progress = {
      message: '正在设计页面和版式。',
      percent: 55,
      updatedAt: 2,
    };

    expect(toCompanionTasks([longTask])).toMatchObject([
      {
        id: 'ppt',
        message: '正在设计页面和版式。',
        progress: {
          message: '正在设计页面和版式。',
          percent: 55,
        },
      },
    ]);
  });

  it('normalizes scheduler and controller status names', () => {
    expect(toCompanionTaskStatus('starting')).toBe('queued');
    expect(toCompanionTaskStatus('executing')).toBe('running');
    expect(toCompanionTaskStatus('done')).toBeNull();
  });
});
