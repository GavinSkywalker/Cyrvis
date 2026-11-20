import type { CompanionTask, CompanionTaskStatus } from '@shared/companion';
import type { RuntimeTask } from './types';

const displayProgressMessage = (message: string): string => {
  const value = message.trim();
  if (/^atomic_prepared$/i.test(value)) return '正在准备执行';
  if (/^gui_/i.test(value)) return '正在操作桌面应用';
  if (/^coding_/i.test(value)) return '正在处理代码和文件';
  if (/^workflow_/i.test(value)) return '正在推进任务步骤';
  return value;
};

export function toCompanionTaskStatus(
  status: string,
): CompanionTaskStatus | null {
  if (status === 'queued' || status === 'starting') return 'queued';
  if (status === 'running' || status === 'executing') return 'running';
  if (status === 'waiting_confirmation') return 'waiting_confirmation';
  if (status === 'paused') return 'paused';
  if (status === 'cancelling') return 'cancelling';
  return null;
}

export function isUserVisibleCompanionTask(task: RuntimeTask): boolean {
  const metadata = task.payload.metadata;
  if (metadata?.userVisible === false) return false;
  if (metadata?.userVisible === true) return true;
  return metadata?.fastTool !== true;
}

export function toCompanionTasks(
  runtimeTasks: RuntimeTask[],
  limit = 8,
): CompanionTask[] {
  const tasks: CompanionTask[] = [];
  for (const task of runtimeTasks) {
    if (!isUserVisibleCompanionTask(task)) continue;
    const status = toCompanionTaskStatus(task.status);
    if (!status) continue;
    const completedSteps = Number(task.checkpoint?.data.completedSteps);
    const totalSteps = Number(task.checkpoint?.data.totalSteps);
    const checkpointPercent =
      Number.isFinite(completedSteps) &&
      Number.isFinite(totalSteps) &&
      totalSteps > 0
        ? Math.max(
            0,
            Math.min(100, Math.round((completedSteps / totalSteps) * 100)),
          )
        : null;
    const progress = task.progress
      ? {
          message: displayProgressMessage(task.progress.message),
          percent: task.progress.percent,
          updatedAt: task.progress.updatedAt,
        }
      : checkpointPercent === null
        ? null
        : {
            message: displayProgressMessage(task.checkpoint?.phase || ''),
            percent: checkpointPercent,
            updatedAt: task.checkpoint?.at || task.updatedAt,
          };
    tasks.push({
      id: task.id,
      kind: task.kind,
      title: task.goal,
      status,
      progress,
      message:
        progress?.message ||
        task.error ||
        task.result ||
        (status === 'queued'
          ? '等待执行'
          : status === 'waiting_confirmation'
            ? '等待确认'
            : '正在执行'),
      startedAt: task.startedAt,
      updatedAt: task.updatedAt,
    });
  }
  return tasks
    .sort(
      (left, right) =>
        (right.startedAt || right.updatedAt) -
        (left.startedAt || left.updatedAt),
    )
    .slice(0, limit);
}
