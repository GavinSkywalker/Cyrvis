import {
  Activity,
  Ban,
  Check,
  Database,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type {
  AutonomyProposalView,
  CapabilityProposalView,
  RuntimeSnapshotView,
  RuntimeTaskView,
} from '@shared/orchestration';

const ACTIVE_STATUSES = new Set([
  'queued',
  'running',
  'waiting_confirmation',
  'paused',
  'cancelling',
]);

const statusColor = (status: string) => {
  if (status === 'done') return 'text-emerald-700 bg-emerald-50';
  if (status === 'failed') return 'text-red-700 bg-red-50';
  if (status === 'waiting_confirmation') return 'text-amber-700 bg-amber-50';
  if (status === 'running') return 'text-blue-700 bg-blue-50';
  return 'text-gray-600 bg-gray-100';
};

const formatTime = (value: number | null) =>
  value ? new Date(value).toLocaleTimeString() : '—';

export default function CyrvisRuntimePanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshotView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const refresh = async () => {
    try {
      setError('');
      setSnapshot(await window.electron.runtime.getSnapshot());
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    }
  };

  useEffect(() => {
    const api = window.electron.runtime;
    if (!api) return;
    void refresh();
    return api.onSnapshot(setSnapshot);
  }, []);

  useEffect(() => {
    const closeForGaze = () => {
      if (window.innerWidth < 900) setOpen(false);
    };
    window.addEventListener('cyrvis:gaze-open', closeForGaze);
    return () => window.removeEventListener('cyrvis:gaze-open', closeForGaze);
  }, []);

  useEffect(() => {
    const keepRuntimePanelVisible = () => {
      if (open && window.innerWidth < 900) {
        window.dispatchEvent(new Event('cyrvis:runtime-open'));
      }
    };
    window.addEventListener('resize', keepRuntimePanelVisible);
    return () => window.removeEventListener('resize', keepRuntimePanelVisible);
  }, [open]);

  const togglePanel = () => {
    const next = !open;
    if (next) window.dispatchEvent(new Event('cyrvis:runtime-open'));
    setOpen(next);
  };

  const run = async (key: string, operation: () => Promise<unknown>) => {
    try {
      setBusy(key);
      setError('');
      await operation();
      await refresh();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setBusy('');
    }
  };

  const taskAction = (
    task: RuntimeTaskView,
    action: 'pause' | 'resume' | 'cancel' | 'confirm' | 'retry',
  ) =>
    run(`${task.id}:${action}`, () =>
      window.electron.runtime.taskAction(action, task.id),
    );

  const autonomyAction = (
    proposal: AutonomyProposalView,
    action: 'accept' | 'reject',
  ) =>
    run(`${proposal.id}:${action}`, () =>
      window.electron.runtime.autonomyAction(action, proposal.id),
    );

  const capabilityAction = (
    proposal: CapabilityProposalView,
    action: 'approve' | 'reject',
  ) =>
    run(`${proposal.id}:${action}`, () =>
      window.electron.runtime.capabilityAction(action, proposal.id),
    );

  const tasks = snapshot?.taskQueue.tasks.slice(0, 8) || [];
  const autonomyProposals =
    snapshot?.autonomy.proposals
      .filter((proposal) => proposal.status === 'proposed')
      .slice(0, 5) || [];
  const capabilityProposals = snapshot?.capabilities.proposed.slice(0, 5) || [];

  return (
    <>
      <button
        className="non-draggable-area fixed top-3 right-[108px] z-[9000] flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2.5 text-xs text-gray-700 shadow-sm"
        aria-expanded={open}
        aria-controls="cyrvis-runtime-panel"
        onClick={togglePanel}
        title="运行控制"
      >
        <Activity className="h-3.5 w-3.5" />
        运行
        {snapshot?.taskQueue.active ? (
          <span className="rounded-full bg-blue-600 px-1.5 text-[10px] text-white">
            {snapshot.taskQueue.active}
          </span>
        ) : null}
      </button>

      {open && (
        <aside
          id="cyrvis-runtime-panel"
          className="non-draggable-area fixed top-[55px] left-[18px] z-[9000] max-h-[calc(100vh-100px)] w-[min(460px,calc(100vw-36px))] overflow-y-auto rounded-xl border border-gray-300 bg-white p-4 text-xs text-gray-800 shadow-xl"
          aria-label="运行控制面板"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-600" />
              <strong className="text-sm">运行控制</strong>
            </div>
            <div className="flex items-center gap-1">
              <select
                className="h-7 rounded-md border border-gray-300 bg-white px-1 text-[11px]"
                aria-label="自主意图模式"
                value={snapshot?.autonomy.mode || 'suggest'}
                disabled={!snapshot || busy !== ''}
                onChange={(event) =>
                  void run('autonomy-mode', () =>
                    window.electron.runtime.configureAutonomy(
                      event.target.value as 'off' | 'suggest' | 'low-risk',
                      snapshot?.autonomy.budget.maxPerHour,
                    ),
                  )
                }
              >
                <option value="off">自主关闭</option>
                <option value="suggest">自主建议</option>
                <option value="low-risk">低风险自动</option>
              </select>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-gray-300 hover:bg-gray-50"
                onClick={() => void refresh()}
                title="刷新"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {error && (
            <p className="mb-3 rounded-md bg-red-50 px-2 py-1.5 text-red-700">
              {error}
            </p>
          )}

          {!snapshot ? (
            <p className="text-gray-500">正在读取运行状态…</p>
          ) : (
            <div className="space-y-4">
              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">系统与用户</h3>
                  <span className="text-[10px] text-gray-400">
                    {formatTime(snapshot.system.runtimeObservedAt)}
                  </span>
                </div>
                <p className="truncate">
                  {snapshot.system.foregroundProcess || '无前台应用'}
                  {snapshot.system.foregroundTitle
                    ? ` · ${snapshot.system.foregroundTitle}`
                    : ''}
                </p>
                <p className="text-gray-500">
                  {snapshot.system.processCount} 进程 ·{' '}
                  {snapshot.system.windowCount} 窗口 · {snapshot.user.activity}{' '}
                  {snapshot.user.confidence.toFixed(2)}
                </p>
                {snapshot.user.gazeTarget && (
                  <p className="truncate text-gray-500">
                    注视：{snapshot.user.gazeTarget}
                  </p>
                )}
                {snapshot.user.candidateIntents.length > 0 && (
                  <p className="truncate text-gray-500">
                    意图：
                    {snapshot.user.candidateIntents
                      .slice(0, 3)
                      .map(
                        (intent) =>
                          `${intent.kind} ${intent.confidence.toFixed(2)}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                {snapshot.user.currentEpisode && (
                  <p className="truncate text-gray-500">
                    活动片段：{snapshot.user.currentEpisode.activity} ·{' '}
                    {snapshot.user.currentEpisode.confidence.toFixed(2)} ·{' '}
                    {snapshot.user.currentEpisode.feedback}
                  </p>
                )}
                {snapshot.perception.length > 0 && (
                  <p className="truncate text-gray-500">
                    Provider：
                    {snapshot.perception
                      .slice(0, 5)
                      .map(
                        (provider) =>
                          `${provider.id}:${provider.state}/${provider.resourceCount}`,
                      )
                      .join(' · ')}
                  </p>
                )}
              </section>

              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">任务队列</h3>
                  <span className="text-gray-500">
                    活动 {snapshot.taskQueue.active}
                  </span>
                </div>
                {snapshot.taskQueue.locks.length > 0 && (
                  <p className="mb-1 truncate text-[10px] text-gray-500">
                    锁：
                    {snapshot.taskQueue.locks
                      .slice(0, 4)
                      .map((lock) => `${lock.mode}:${lock.resource}`)
                      .join(' · ')}
                  </p>
                )}
                {tasks.length === 0 ? (
                  <p className="text-gray-500">没有任务</p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {tasks.map((task) => (
                      <div key={task.id} className="py-2">
                        <div className="flex items-start gap-2">
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${statusColor(task.status)}`}
                          >
                            {task.status}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{task.goal}</p>
                            <p className="truncate text-[10px] text-gray-500">
                              {task.kind} · {task.lane} · {task.priorityClass}
                              {task.externalId
                                ? ` · ${task.externalId.slice(0, 10)}`
                                : ''}
                            </p>
                            {task.checkpoint && (
                              <p className="truncate text-[10px] text-blue-600">
                                检查点 {task.checkpoint.revision} ·{' '}
                                {task.checkpoint.phase}
                              </p>
                            )}
                            {task.progress && task.status === 'running' && (
                              <>
                                <p className="truncate text-[10px] text-blue-700">
                                  {task.progress.message}
                                </p>
                                <div className="mt-1 flex items-center gap-2">
                                  <progress
                                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full accent-blue-600"
                                    max={100}
                                    value={task.progress.percent ?? undefined}
                                    aria-label={`${task.goal}: ${
                                      task.progress.percent === null
                                        ? '处理中'
                                        : `${task.progress.percent}%`
                                    }`}
                                  />
                                  {task.progress.percent !== null && (
                                    <span className="w-8 text-right text-[9px] text-blue-700">
                                      {task.progress.percent}%
                                    </span>
                                  )}
                                </div>
                              </>
                            )}
                            {task.verification.status !== 'not_required' && (
                              <p
                                className={`truncate text-[10px] ${
                                  task.verification.status === 'failed'
                                    ? 'text-red-600'
                                    : 'text-gray-500'
                                }`}
                              >
                                验证 {task.verification.status}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {task.status === 'waiting_confirmation' && (
                              <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded border border-amber-300 text-amber-700"
                                title="确认任务"
                                disabled={busy !== ''}
                                onClick={() => void taskAction(task, 'confirm')}
                              >
                                <Check className="h-3 w-3" />
                              </button>
                            )}
                            {task.status === 'running' && (
                              <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded border border-gray-300"
                                title="暂停任务"
                                disabled={busy !== ''}
                                onClick={() => void taskAction(task, 'pause')}
                              >
                                <Pause className="h-3 w-3" />
                              </button>
                            )}
                            {task.status === 'paused' && (
                              <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded border border-gray-300"
                                title="继续任务"
                                disabled={busy !== ''}
                                onClick={() => void taskAction(task, 'resume')}
                              >
                                <Play className="h-3 w-3" />
                              </button>
                            )}
                            {task.status === 'failed' && (
                              <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded border border-blue-200 text-blue-700"
                                title="重试任务"
                                disabled={busy !== ''}
                                onClick={() => void taskAction(task, 'retry')}
                              >
                                <RefreshCw className="h-3 w-3" />
                              </button>
                            )}
                            {ACTIVE_STATUSES.has(task.status) && (
                              <button
                                type="button"
                                className="flex h-6 w-6 items-center justify-center rounded border border-red-200 text-red-600"
                                title="取消任务"
                                disabled={busy !== ''}
                                onClick={() => void taskAction(task, 'cancel')}
                              >
                                <Ban className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">自主建议</h3>
                  <span className="text-gray-500">
                    {snapshot.autonomy.budget.usedLastHour}/
                    {snapshot.autonomy.budget.maxPerHour}
                    {snapshot.autonomy.budget.quietHours.active
                      ? ' · 静默'
                      : ''}
                  </span>
                </div>
                {autonomyProposals.length === 0 ? (
                  <p className="text-gray-500">没有待处理建议</p>
                ) : (
                  autonomyProposals.map((proposal) => (
                    <div
                      key={proposal.id}
                      className="flex items-start gap-2 border-t border-gray-100 py-2 first:border-0"
                    >
                      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{proposal.title}</p>
                        <p className="line-clamp-2 text-[10px] text-gray-500">
                          {proposal.reason}
                        </p>
                        <p className="text-[10px] text-gray-400">
                          分数 {proposal.score.toFixed(1)} · 打扰成本{' '}
                          {proposal.attentionCost.toFixed(2)}
                          {proposal.interruptive ? ' · 可提示' : ' · 静默'}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded border border-emerald-200 text-emerald-700"
                        title="接受建议"
                        disabled={busy !== ''}
                        onClick={() => void autonomyAction(proposal, 'accept')}
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded border border-gray-300"
                        title="拒绝建议"
                        disabled={busy !== ''}
                        onClick={() => void autonomyAction(proposal, 'reject')}
                      >
                        <Ban className="h-3 w-3" />
                      </button>
                    </div>
                  ))
                )}
              </section>

              <section>
                <h3 className="mb-1 font-semibold">能力提案</h3>
                {capabilityProposals.length === 0 ? (
                  <p className="text-gray-500">没有待处理能力提案</p>
                ) : (
                  capabilityProposals.map((proposal) => (
                    <div
                      key={proposal.id}
                      className="flex items-start gap-2 border-t border-gray-100 py-2 first:border-0"
                    >
                      <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-700" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{proposal.title}</p>
                        <p className="line-clamp-2 text-[10px] text-gray-500">
                          {proposal.reason}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded border border-emerald-200 text-emerald-700"
                        title="批准能力"
                        disabled={busy !== ''}
                        onClick={() =>
                          void capabilityAction(proposal, 'approve')
                        }
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded border border-gray-300"
                        title="拒绝能力"
                        disabled={busy !== ''}
                        onClick={() =>
                          void capabilityAction(proposal, 'reject')
                        }
                      >
                        <Ban className="h-3 w-3" />
                      </button>
                    </div>
                  ))
                )}
              </section>

              <section>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">运行轨迹</h3>
                  <span
                    className={
                      snapshot.replay.gaps.length
                        ? 'text-amber-700'
                        : 'text-emerald-700'
                    }
                  >
                    {snapshot.replay.gaps.length
                      ? `${snapshot.replay.gaps.length} 个缺口`
                      : '连续'}
                  </span>
                </div>
                {snapshot.recentEvents.length === 0 ? (
                  <p className="text-gray-500">暂无轨迹</p>
                ) : (
                  <div className="space-y-1">
                    {snapshot.recentEvents
                      .slice(-6)
                      .reverse()
                      .map((event) => (
                        <div
                          key={event.id}
                          className="flex items-start gap-2 text-[10px]"
                        >
                          <span className="w-12 shrink-0 text-gray-400">
                            {formatTime(event.at)}
                          </span>
                          <span className="w-16 shrink-0 truncate text-gray-500">
                            {event.category}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-gray-700">
                            {event.summary}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </section>

              <section className="flex items-center justify-between border-t border-gray-100 pt-2">
                <p className="text-[10px] text-gray-500">
                  能力 {snapshot.capabilities.available}/
                  {snapshot.capabilities.total} · 记忆版本{' '}
                  {snapshot.memoryRevision} · 轨迹{' '}
                  {snapshot.health.trace ? '正常' : '异常'}
                </p>
                <button
                  type="button"
                  className="flex h-7 items-center gap-1 rounded-md border border-gray-300 px-2 text-[10px]"
                  disabled={busy !== ''}
                  onClick={() =>
                    void run('clear-memory', () =>
                      window.electron.runtime.clearMemory(),
                    )
                  }
                  title="清除临时运行时记忆"
                >
                  <Trash2 className="h-3 w-3" />
                  清空记忆
                </button>
              </section>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
