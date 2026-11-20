import {
  AlertTriangle,
  Clock3,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Square,
  Volume2,
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

import {
  COMPANION_TASK_EXIT_MS,
  voiceErrorMessage,
  type CompanionSnapshot,
  type CompanionTask,
} from '@shared/companion';
import { ConversationBubble } from './ConversationBubble';
import { CompanionArtwork } from './CompanionArtwork';

const stateCopy: Record<CompanionSnapshot['state'], { label: string }> = {
  idle: { label: 'Idle' },
  listening: { label: 'Listening' },
  thinking: { label: 'Thinking' },
  speaking: { label: 'Speaking' },
  working: { label: 'Working' },
  sleeping: { label: 'Sleeping' },
};

const taskStatusLabel: Record<CompanionTask['status'], string> = {
  queued: '排队中',
  running: '执行中',
  waiting_confirmation: '等待确认',
  paused: '已暂停',
  cancelling: '正在停止',
};

type DisplayTask = CompanionTask & { motion: 'enter' | 'exit' };

const TaskStatusIcon = ({ task }: { task: CompanionTask }) => {
  if (task.status === 'waiting_confirmation') {
    return <AlertTriangle className="h-3.5 w-3.5" />;
  }
  if (task.status === 'paused') {
    return <Pause className="h-3.5 w-3.5" />;
  }
  if (task.status === 'queued') {
    return <Clock3 className="h-3.5 w-3.5" />;
  }
  return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
};

export default function Companion() {
  const [snapshot, setSnapshot] = useState<CompanionSnapshot>({
    state: 'idle',
    micReady: false,
    error: null,
  });
  const dragEndRef = useRef<Promise<boolean> | null>(null);
  const [dragging, setDragging] = useState(false);
  const [displayTasks, setDisplayTasks] = useState<DisplayTask[]>([]);
  const displayTasksRef = useRef<DisplayTask[]>([]);
  const taskExitTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  useEffect(() => {
    void window.electron.companion.getState().then(setSnapshot);
    return window.electron.companion.onState(setSnapshot);
  }, []);

  useEffect(() => {
    const incoming = snapshot.tasks;
    if (!incoming) return;
    const incomingIds = new Set(incoming.map((task) => task.id));
    for (const [id, timer] of taskExitTimersRef.current) {
      if (!incomingIds.has(id)) continue;
      clearTimeout(timer);
      taskExitTimersRef.current.delete(id);
    }

    const current = displayTasksRef.current;
    const remaining = new Map(current.map((task) => [task.id, task]));
    const next = incoming.map((task): DisplayTask => {
      const previous = remaining.get(task.id);
      remaining.delete(task.id);
      return {
        ...task,
        motion:
          previous?.motion === 'exit' ? 'enter' : previous?.motion || 'enter',
      };
    });

    for (const task of remaining.values()) {
      next.push({ ...task, motion: 'exit' });
      if (taskExitTimersRef.current.has(task.id)) continue;
      const timer = setTimeout(() => {
        taskExitTimersRef.current.delete(task.id);
        const visible = displayTasksRef.current.filter(
          (candidate) => candidate.id !== task.id,
        );
        displayTasksRef.current = visible;
        setDisplayTasks(visible);
      }, COMPANION_TASK_EXIT_MS);
      taskExitTimersRef.current.set(task.id, timer);
    }

    displayTasksRef.current = next;
    setDisplayTasks(next);
  }, [snapshot.tasks]);

  useEffect(
    () => () => {
      for (const timer of taskExitTimersRef.current.values())
        clearTimeout(timer);
      taskExitTimersRef.current.clear();
    },
    [],
  );

  const endDrag = () => {
    setDragging(false);
    dragEndRef.current ??= window.electron.ipcRenderer.invoke(
      'companion:drag-end',
    ) as Promise<boolean>;
    return dragEndRef.current;
  };
  const openMainWindow = async () => {
    if (!(await endDrag()))
      void window.electron.ipcRenderer.invoke('showMainWindow');
    dragEndRef.current = null;
  };
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    setDragging(true);
    dragEndRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    void window.electron.ipcRenderer.invoke('companion:drag-start');
  };

  const current = stateCopy[snapshot.state];
  const tasks = displayTasks;
  const taskStackExtracting =
    tasks.length > 0 && tasks.every((task) => task.motion === 'exit');
  const assistantActive =
    snapshot.state === 'speaking' || snapshot.state === 'thinking';
  return (
    <main
      className="companion-root"
      data-conversation={snapshot.conversationVisible || undefined}
      data-tasks={tasks.length || undefined}
      aria-label="CYRVIS desktop companion"
    >
      {tasks.length > 0 && (
        <section
          className="companion-task-stack"
          data-motion={taskStackExtracting ? 'extract' : 'open'}
          aria-label="Active tasks"
        >
          <header>
            <span>进行中的任务</span>
            <span>{tasks.length}</span>
          </header>
          <ol aria-live="polite">
            {tasks.slice(0, 5).map((task) => (
              <li
                key={task.id}
                data-motion={task.motion}
                data-status={task.status}
              >
                <span className="companion-task-status-icon">
                  <TaskStatusIcon task={task} />
                </span>
                <div>
                  <p>{task.title}</p>
                  <small>{task.message || taskStatusLabel[task.status]}</small>
                  {task.progress?.percent !== null &&
                  task.progress?.percent !== undefined ? (
                    <small className="companion-task-percent">
                      {task.progress.percent}%
                    </small>
                  ) : null}
                </div>
                <span className="companion-task-state">
                  {taskStatusLabel[task.status]}
                </span>
                {task.status === 'running' && task.progress ? (
                  <progress
                    className="companion-task-progress"
                    max={100}
                    value={task.progress.percent ?? undefined}
                    aria-label={`${task.title}: ${task.progress.percent === null ? 'processing' : `${task.progress.percent}%`}`}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      )}
      <ConversationBubble snapshot={snapshot} />
      <div className="companion-robot">
        <button
          type="button"
          className="companion-button"
          aria-label={`${current.label}. Click to open Cyrvis. Right-click for options.`}
          title={
            (snapshot.error && voiceErrorMessage(snapshot.error)) ||
            `${current.label} · ${snapshot.micReady ? 'Microphone on' : 'Microphone off'}`
          }
          onPointerDown={handlePointerDown}
          onPointerUp={() => void endDrag()}
          onPointerCancel={() => void endDrag()}
          onClick={openMainWindow}
          onContextMenu={(event) => {
            event.preventDefault();
            void window.electron.ipcRenderer.invoke('companion:menu');
          }}
        >
          <CompanionArtwork
            skinId={snapshot.skinId}
            state={snapshot.state}
            label={current.label}
            dragging={dragging}
          />
          <span className="companion-status" aria-hidden="true">
            <span
              className={`companion-dot ${snapshot.micReady ? 'is-ready' : ''}`}
            />
            {snapshot.error
              ? 'Voice or history unavailable · Right-click for settings'
              : `${current.label} · ${snapshot.micReady ? 'Mic on' : 'Mic off'}${
                  snapshot.audioMode === 'speaker' ? ' · Speakers' : ''
                }`}
          </span>
        </button>
        <div className="companion-controls" aria-label="Voice controls">
          <button
            type="button"
            className="companion-control-button"
            disabled={snapshot.connecting}
            aria-label={
              snapshot.micReady ? 'Pause conversation' : 'Start conversation'
            }
            title={
              snapshot.micReady ? 'Pause conversation' : 'Start conversation'
            }
            onClick={() =>
              void window.electron.companion.command(
                snapshot.micReady ? 'stop' : 'start',
              )
            }
          >
            {snapshot.connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : snapshot.micReady ? (
              <Mic className="h-4 w-4" />
            ) : (
              <MicOff className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className="companion-control-button"
            aria-label={
              snapshot.audioMode === 'speaker' ? 'Use headset' : 'Use speakers'
            }
            title={
              snapshot.audioMode === 'speaker'
                ? 'Switch to headset mode'
                : 'Switch to speakers mode'
            }
            onClick={() => void window.electron.companion.command('audio-mode')}
          >
            {snapshot.audioMode === 'speaker' ? (
              <Headphones className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className="companion-control-button"
            disabled={!assistantActive}
            aria-label="Interrupt response"
            title={
              assistantActive ? 'Interrupt response' : 'Nothing to interrupt'
            }
            onClick={() => void window.electron.companion.command('interrupt')}
          >
            <Square className="h-4 w-4" />
          </button>
        </div>
      </div>
    </main>
  );
}
