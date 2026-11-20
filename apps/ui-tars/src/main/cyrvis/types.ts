/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StepUpdate, TaskSource } from '@shared/cyrvis';

export type {
  ControllerEvent,
  StepUpdate,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from '@shared/cyrvis';

export interface TaskRequest {
  taskId: string;
  instruction: string;
  source: TaskSource;
  createdAt: number;
}

export interface GUIAdapterCallbacks {
  onStarted: () => void;
  onStep: (step: StepUpdate) => void;
  onNeedsUser: (question: string) => void;
  onPaused: () => void;
  onResumed: () => void;
  onDone: (summary: string) => void;
  onFailed: (error: string) => void;
  onCancelled: () => void;
}

/**
 * Provider-independent GUI executor contract.
 * The real implementation wraps UI-TARS `runAgent`; tests can use a fake.
 */
export interface GUIAdapter {
  start(instruction: string, callbacks: GUIAdapterCallbacks): Promise<void>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export type VoiceToolCall =
  | { name: 'inspect_gaze_target'; args: { question?: string } }
  | {
      name: 'start_gui_task';
      args: { instruction: string; confidence?: number };
    }
  | { name: 'cancel_gui_task'; args: { task_id?: string } }
  | { name: 'pause_gui_task'; args: Record<string, never> }
  | { name: 'resume_gui_task'; args: Record<string, never> }
  | { name: 'get_gui_status'; args: Record<string, never> }
  | { name: 'remember_fact'; args: { text: string } }
  | {
      name: 'search_web';
      args: {
        query: string;
        engine?: 'bing' | 'baidu' | 'google';
        site?: string;
        task_instruction?: string;
      };
    }
  | {
      name: 'open_url';
      args: { url: string; task_instruction?: string };
    }
  | {
      name: 'open_app';
      args: {
        app: 'vscode' | 'chrome' | 'explorer' | 'notepad';
        target?: string;
        task_instruction?: string;
      };
    }
  | {
      name: 'create_text_file';
      args: {
        path: string;
        content: string;
        open?: boolean;
        overwrite?: boolean;
      };
    }
  | {
      name: 'start_coding_task';
      args: { instruction: string; workspace?: string };
    }
  | { name: 'get_coding_status'; args: Record<string, never> }
  | { name: 'cancel_coding_task'; args: Record<string, never> }
  | {
      name: 'open_site';
      args: { site: string; query?: string; task_instruction?: string };
    }
  | { name: 'close_webpage'; args: { query: string } }
  | {
      name: 'create_presentation';
      args: {
        path: string;
        title: string;
        content?: string;
        sourcePath?: string;
        pageCount?: number;
        audience?: string;
        templateId?: string;
        mode?: 'general' | 'creative';
        provider?: 'auto' | 'qwen-doc' | 'powerpoint' | 'remote-api';
      };
    }
  | {
      name: `cyrvis_${string}`;
      args: Record<string, unknown>;
    }
  | {
      name: 'travel_update_plan';
      args: {
        destination?: string;
        origin?: string;
        start_date?: string;
        end_date?: string;
        companions?: string;
        budget?: string;
        purpose?: string;
        transport?: string;
        user_text?: string;
      };
    }
  | { name: 'travel_get_plan'; args: Record<string, never> }
  | { name: 'travel_confirm_skeleton'; args: Record<string, never> }
  | { name: 'travel_probe_highlights'; args: Record<string, never> }
  | {
      name: 'travel_set_preference';
      args: { interest: string; notes?: string };
    }
  | {
      name: 'travel_set_constraints';
      args: {
        ok_with_walking?: boolean;
        ok_with_early_start?: boolean;
        ok_with_queues?: boolean;
        notes?: string;
        user_text?: string;
      };
    }
  | {
      name: 'travel_expand_aspect';
      args: { aspect: string; notes?: string; with_search?: boolean };
    }
  | {
      name: 'travel_search';
      args: { query?: string; aspect?: string };
    }
  | { name: 'travel_decline_expand'; args: Record<string, never> }
  | { name: 'travel_finalize_plan'; args: Record<string, never> };

export type ProactivityReason =
  | 'task_started'
  | 'task_stalled'
  | 'task_needs_user'
  | 'task_done'
  | 'task_failed'
  | 'task_cancelled'
  | 'progress'
  | 'suggestion';

export type ProactivityPriority = 0 | 1 | 2 | 3;

export interface ProactiveUtterance {
  text: string;
  priority: ProactivityPriority;
  reason: ProactivityReason;
}
