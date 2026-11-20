import type { CodingAgentService } from '../coding-agent';
import type { CyrvisController } from '../controller';
import type { ControllerEvent } from '../types';
import type { ToolRegistry } from '../tools/registry';
import type { LocalWorkflowEngine } from '../tools/workflow-engine';
import type {
  ToolExecutionContract,
  ToolVerificationResult,
} from '../tools/types';
import type { RuntimeTask } from './types';
import type {
  TaskExecutionResult,
  TaskExecutor,
  TaskExecutorCallbacks,
} from './task-scheduler';

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AtomicTaskExecutor implements TaskExecutor {
  readonly kind;

  constructor(
    private readonly registry: ToolRegistry,
    kind: 'atomic' | 'observe' = 'atomic',
  ) {
    this.kind = kind;
  }

  contractFor(task: RuntimeTask): ToolExecutionContract {
    const definition = task.payload.tool
      ? this.registry.get(task.payload.tool)
      : undefined;
    if (!definition) return {};
    const readOnly =
      /(?:list|read|inspect|snapshot|search|get_info|exists|hash)/i.test(
        definition.name,
      );
    return {
      ...definition.contract,
      sideEffect:
        definition.contract?.sideEffect ||
        (definition.risk === 'high'
          ? 'irreversible'
          : readOnly
            ? 'read'
            : 'external'),
      idempotent: definition.contract?.idempotent ?? readOnly,
      retryable: definition.contract?.retryable ?? readOnly,
      verification:
        definition.contract?.verification ||
        (definition.verify ? 'required' : 'none'),
    };
  }

  async start(
    task: RuntimeTask,
    callbacks: TaskExecutorCallbacks,
  ): Promise<TaskExecutionResult> {
    const tool = task.payload.tool?.trim();
    if (!tool) return { ok: false, summary: '任务缺少原子工具名。' };
    const prepared = await this.registry.prepare(tool, task.payload.args || {});
    callbacks.checkpoint('atomic_prepared', {
      tool,
      requiresConfirmation: prepared.requiresConfirmation,
    });
    const result = await this.registry.executePrepared(prepared, {
      confirmed: true,
      onProgress: (message, percent) =>
        callbacks.progress(message, null, percent),
    });
    return {
      ok: result.ok,
      summary: result.speech,
      data: result.data,
      verification: this.verificationFromData(result.data),
    };
  }

  async verify(
    _task: RuntimeTask,
    result: TaskExecutionResult,
  ): Promise<ToolVerificationResult> {
    if (result.verification) return result.verification;
    return {
      ok: result.ok,
      message: result.ok
        ? '工具返回成功，未声明额外独立验证。'
        : result.summary,
    };
  }

  async cancel(task: RuntimeTask): Promise<void> {
    void task;
  }

  async confirm(_task: RuntimeTask): Promise<boolean> {
    return false;
  }

  private verificationFromData(
    data: unknown,
  ): ToolVerificationResult | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return undefined;
    }
    const verification = (
      data as {
        verification?: { ok?: unknown; message?: unknown; data?: unknown };
      }
    ).verification;
    if (!verification) return undefined;
    return {
      ok: verification.ok === true,
      message:
        typeof verification.message === 'string'
          ? verification.message
          : verification.ok === true
            ? '工具结果验证通过。'
            : '工具结果验证失败。',
      data: verification.data,
    };
  }
}

export class WorkflowTaskExecutor implements TaskExecutor {
  readonly kind = 'workflow' as const;
  private readonly runs = new Map<string, string>();

  constructor(private readonly workflow: LocalWorkflowEngine) {}

  contractFor(): ToolExecutionContract {
    return {
      sideEffect: 'external',
      idempotent: false,
      retryable: false,
      maxAttempts: 1,
      timeoutMs: 24 * 60 * 60_000,
      resumePolicy: 'verify_then_resume',
      verification: 'required',
    };
  }

  async start(
    task: RuntimeTask,
    callbacks: TaskExecutorCallbacks,
  ): Promise<TaskExecutionResult> {
    if (!task.payload.workflow) {
      return { ok: false, summary: '任务缺少工作流定义。' };
    }
    const checkpointRunId =
      typeof task.checkpoint?.data.runId === 'string'
        ? task.checkpoint.data.runId
        : null;
    let run = checkpointRunId ? await this.workflow.get(checkpointRunId) : null;
    if (run?.status === 'paused') {
      await this.workflow.resume(run.id);
      run = await this.workflow.get(run.id);
    }
    run ||= await this.workflow.start(task.payload.workflow);
    this.runs.set(task.id, run.id);
    callbacks.progress(`工作流已启动：${run.name}`, run.id);
    callbacks.checkpoint('workflow_linked', {
      runId: run.id,
      resumed: Boolean(checkpointRunId),
    });

    return new Promise<TaskExecutionResult>((resolve) => {
      let settled = false;
      const finish = (result: TaskExecutionResult) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        this.runs.delete(task.id);
        resolve(result);
      };
      const unsubscribe = this.workflow.subscribe((event) => {
        if (event.run.id !== run.id) return;
        if (event.type === 'waiting_confirmation') {
          callbacks.waitingConfirmation(event.message, run.id);
          return;
        }
        if (event.type === 'step_done') {
          const completedSteps = event.run.steps.filter(
            (step) => step.status === 'done',
          ).length;
          const totalSteps = Math.max(1, event.run.steps.length);
          callbacks.progress(
            event.message,
            run.id,
            (completedSteps / totalSteps) * 100,
          );
          callbacks.checkpoint('workflow_step_done', {
            runId: run.id,
            stepId: event.stepId || null,
            completedSteps,
            totalSteps,
          });
          return;
        }
        if (event.type === 'done') {
          callbacks.checkpoint('workflow_done', { runId: run.id });
          finish({
            ok: true,
            summary: event.message,
            data: event.run,
            verification: {
              ok: true,
              message: `工作流 ${event.run.name} 的全部步骤已完成。`,
              data: {
                stepCount: event.run.steps.length,
              },
            },
          });
        } else if (event.type === 'failed') {
          finish({ ok: false, summary: event.message, data: event.run });
        } else if (event.type === 'cancelled') {
          finish({
            ok: false,
            summary: `任务已取消：${event.run.name}`,
            data: event.run,
          });
        }
      });
      const existing = this.workflow.latestSnapshot(false);
      const current = existing?.id === run.id ? existing : run;
      if (current) {
        if (current.status === 'done') {
          finish({
            ok: true,
            summary: `工作流 ${run.name} 已完成。`,
            data: current,
            verification: {
              ok: true,
              message: `工作流 ${run.name} 的持久化状态为已完成。`,
              data: { stepCount: current.steps.length },
            },
          });
        } else if (current.status === 'failed') {
          finish({
            ok: false,
            summary: current.error || `工作流 ${run.name} 失败。`,
          });
        } else if (current.status === 'cancelled') {
          finish({ ok: false, summary: `工作流 ${run.name} 已取消。` });
        } else if (current.status === 'waiting_confirmation') {
          callbacks.waitingConfirmation(
            current.pendingConfirmation?.reason || '工作流需要确认。',
            run.id,
          );
        }
      }
    });
  }

  async verify(
    task: RuntimeTask,
    result: TaskExecutionResult,
  ): Promise<ToolVerificationResult> {
    if (result.verification) return result.verification;
    const runId = this.runs.get(task.id);
    const run = runId ? await this.workflow.get(runId) : null;
    return {
      ok: result.ok && run?.status === 'done',
      message:
        run?.status === 'done'
          ? `工作流 ${run.name} 已由持久化状态确认完成。`
          : result.summary,
    };
  }

  async cancel(task: RuntimeTask): Promise<void> {
    const runId = this.runs.get(task.id);
    if (runId) await this.workflow.cancel(runId);
  }

  async confirm(task: RuntimeTask): Promise<boolean> {
    const runId = this.runs.get(task.id);
    if (!runId) return false;
    return Boolean(await this.workflow.confirm(runId));
  }
}

export class GUITaskExecutor implements TaskExecutor {
  readonly kind = 'gui' as const;
  private readonly taskIds = new Map<string, string>();

  constructor(private readonly controller: CyrvisController) {}

  contractFor(): ToolExecutionContract {
    return {
      sideEffect: 'external',
      idempotent: false,
      retryable: false,
      maxAttempts: 1,
      timeoutMs: 2 * 60 * 60_000,
      resumePolicy: 'manual',
      verification: 'required',
    };
  }

  async start(
    task: RuntimeTask,
    callbacks: TaskExecutorCallbacks,
  ): Promise<TaskExecutionResult> {
    const instruction = task.payload.instruction?.trim() || task.goal;
    const snapshot = this.controller.startTask(instruction, 'voice');
    if (!snapshot.taskId) {
      return { ok: false, summary: 'GUI 任务未返回任务 ID。' };
    }
    const taskId = snapshot.taskId;
    this.taskIds.set(task.id, taskId);
    callbacks.progress(`GUI 任务已启动：${instruction.slice(0, 120)}`, taskId);
    callbacks.checkpoint('gui_task_started', {
      controllerTaskId: taskId,
      instruction,
    });

    return new Promise<TaskExecutionResult>((resolve) => {
      let settled = false;
      const finish = (result: TaskExecutionResult) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        this.taskIds.delete(task.id);
        resolve(result);
      };
      const unsubscribe = this.controller.onEvent((event: ControllerEvent) => {
        if (!('taskId' in event) || event.taskId !== taskId) return;
        if (event.type === 'step_update') {
          callbacks.progress(event.summary, taskId);
          callbacks.checkpoint('gui_step_update', {
            controllerTaskId: taskId,
            step: event.step,
            summary: event.summary.slice(0, 500),
          });
        } else if (event.type === 'task_needs_user') {
          callbacks.waitingConfirmation(event.question, taskId);
        } else if (event.type === 'task_paused') {
          callbacks.paused('GUI 任务已暂停。');
        } else if (event.type === 'task_done') {
          finish({
            ok: true,
            summary: event.summary,
            data: event,
            verification: {
              ok: true,
              message: 'GUI Controller 已报告任务完成。',
            },
          });
        } else if (event.type === 'task_failed') {
          finish({ ok: false, summary: event.error, data: event });
        } else if (event.type === 'task_cancelled') {
          finish({ ok: false, summary: 'GUI 任务已取消。', data: event });
        }
      });
    });
  }

  async cancel(task: RuntimeTask): Promise<void> {
    await this.controller.cancelTask(this.taskIds.get(task.id));
  }

  async pause(task: RuntimeTask): Promise<boolean> {
    const taskId = this.taskIds.get(task.id);
    if (!taskId) return false;
    await this.controller.pauseTask(taskId);
    return this.controller.getStatus().status === 'paused';
  }

  async resume(task: RuntimeTask): Promise<boolean> {
    const taskId = this.taskIds.get(task.id);
    if (!taskId) return false;
    await this.controller.resumeTask(taskId);
    return this.controller.getStatus().status === 'executing';
  }

  async verify(
    _task: RuntimeTask,
    result: TaskExecutionResult,
  ): Promise<ToolVerificationResult> {
    return (
      result.verification || {
        ok: result.ok,
        message: result.ok ? 'GUI Controller 已确认任务完成。' : result.summary,
      }
    );
  }
}

export class CodingTaskExecutor implements TaskExecutor {
  readonly kind = 'coding' as const;
  private readonly tasks = new Set<string>();

  constructor(private readonly codingAgent: CodingAgentService) {}

  contractFor(): ToolExecutionContract {
    return {
      sideEffect: 'write',
      idempotent: false,
      retryable: false,
      maxAttempts: 1,
      timeoutMs: 2 * 60 * 60_000,
      resumePolicy: 'manual',
      verification: 'required',
    };
  }

  async start(
    task: RuntimeTask,
    callbacks: TaskExecutorCallbacks,
  ): Promise<TaskExecutionResult> {
    const requestedWorkspace = task.payload.workspace?.trim();
    if (
      requestedWorkspace &&
      requestedWorkspace !== this.codingAgent.getWorkspace()
    ) {
      return {
        ok: false,
        summary: '编码任务工作区不在当前允许的固定工作区内。',
      };
    }
    const instruction = task.payload.instruction?.trim() || task.goal;
    const snapshot = await this.codingAgent.start(instruction);
    const codingTaskId = snapshot.taskId;
    if (!codingTaskId) {
      return { ok: false, summary: '编码任务未返回任务 ID。' };
    }
    this.tasks.add(task.id);
    callbacks.progress('编码任务已启动。', codingTaskId);
    callbacks.checkpoint('coding_task_started', {
      codingTaskId,
      workspace: this.codingAgent.getWorkspace(),
    });
    let lastMessage = '';
    try {
      while (this.tasks.has(task.id)) {
        const current = this.codingAgent.getStatus();
        if (current.taskId !== codingTaskId) {
          return { ok: false, summary: '编码任务状态被其他任务替换。' };
        }
        if (current.lastMessage && current.lastMessage !== lastMessage) {
          lastMessage = current.lastMessage;
          callbacks.progress(current.lastMessage, codingTaskId);
          callbacks.checkpoint('coding_progress', {
            codingTaskId,
            message: current.lastMessage.slice(0, 500),
            changedFiles: current.changedFiles.slice(-50),
          });
        }
        if (current.status === 'done') {
          return {
            ok: true,
            summary: current.result || '编码任务已完成。',
            data: current,
            verification: {
              ok: current.status === 'done',
              message: `编码 Agent 状态为 ${current.status}，变更文件 ${current.changedFiles.length} 个。`,
              data: {
                changedFiles: current.changedFiles,
                workspace: current.workspace,
              },
            },
          };
        }
        if (current.status === 'failed') {
          return {
            ok: false,
            summary: current.error || '编码任务失败。',
            data: current,
          };
        }
        if (current.status === 'cancelled') {
          return { ok: false, summary: '编码任务已取消。', data: current };
        }
        await wait(500);
      }
      return { ok: false, summary: '编码任务已取消。' };
    } finally {
      this.tasks.delete(task.id);
    }
  }

  async cancel(task: RuntimeTask): Promise<void> {
    this.tasks.delete(task.id);
    await this.codingAgent.cancel();
  }

  async verify(
    _task: RuntimeTask,
    result: TaskExecutionResult,
  ): Promise<ToolVerificationResult> {
    return (
      result.verification || {
        ok:
          result.ok &&
          Boolean(
            (result.data as { status?: string } | undefined)?.status === 'done',
          ),
        message: result.summary,
      }
    );
  }
}
