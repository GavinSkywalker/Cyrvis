/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export interface QwenToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const CYRVIS_VOICE_TOOLS: QwenToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'inspect_gaze_target',
      description:
        'Read-only: capture the region of the primary desktop the user is looking at and ask the visual model what is there. Use for 我在看什么、这个是什么、帮我看看这里. Coordinates alone do not reveal screen content. Does not click or control any app.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The user question about the area they are looking at.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_gui_task',
      description:
        'Fallback GUI task executor. Call this only when no cyrvis_* local fast tool or voice fast tool can complete the request, or when the request requires visual inspection, interaction with an existing app UI, login, popups, dragging, or other multi-step GUI work. For live search/information needs, call search_web first. Never call for greetings, thanks, identity questions, stable knowledge you can answer directly, or chit-chat.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'A clear, self-contained instruction for the GUI agent, including app name and target.',
          },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_gui_task',
      description:
        'Stop the currently running GUI task. Use when the user says stop, cancel, never mind, or asks to abort.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Optional task id; omit to cancel the active task.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_gui_task',
      description: 'Pause the currently running GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_gui_task',
      description: 'Resume the paused GUI task.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_gui_status',
      description:
        'Get the current GUI task status, progress, last step, and error. Use when the user asks what is happening or how far the task has gone.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        'Store a durable user preference, identity fact, or recurring context after the user explicitly asks you to remember it. Never store passwords, API keys, tokens, or other secrets.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'A concise, self-contained fact or preference to retain across sessions.',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        'Open a web search in the platform browser (Bing on Windows, Safari on macOS). Use it only when the user explicitly asks to search/look something up, needs live or time-sensitive information (prices, flights/hotels, weather, news, scores, opening hours, policies), asks about a specific place/business/official site, or asks you to verify a source. Do NOT use it for stable knowledge you can answer from memory (e.g. "介绍邓小平", "邓小平是谁", "B站怎么投币", "怎么安装 Node.js") — answer those directly. For bare navigation like "打开B站/打开淘宝", use open_site instead. If the user also wants you to read, compare, or click the results, set task_instruction so the GUI agent continues after the page opens.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query, e.g. "去巴黎的机票".',
          },
          engine: {
            type: 'string',
            enum: ['bing', 'baidu', 'google'],
            description:
              'Search engine; default is the platform default (Bing on Windows, Google on macOS).',
          },
          site: {
            type: 'string',
            description:
              'Optional site filter, e.g. "ctrip.com" or "taobao.com". The query becomes "<query> site:<site>".',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the results page opens, e.g. "查看携程的机票结果并告诉我前三个选项". Only include when the user wants page interaction.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description:
        'Open an http/https URL directly in the default browser. Use this instead of GUI clicking when the user gives a URL or a known page to open. Optional task_instruction starts a GUI task after the page opens.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Full http/https URL to open.',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the page opens, e.g. "在页面中查看搜索结果".',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        'Open a supported desktop app through the local tool registry. Use for opening VS Code, Chrome, Explorer, Notepad, Calculator, Paint or other supported app aliases. If the user wants work inside the app, set task_instruction so the GUI agent continues after it opens.',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Allowlisted application to open.',
          },
          target: {
            type: 'string',
            description:
              'Optional file/folder path or URL to open with the app.',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the app opens, e.g. "在 VS Code 中打开 main.ts 并修改端口".',
          },
        },
        required: ['app'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_text_file',
      description:
        'Create or overwrite a text file and optionally open it with the default app. Use this for deterministic text/document creation, especially "打开记事本，从1写到100", "新建 todo.txt，写入..." or "把这段内容保存到桌面". Generate the full file content yourself and pass it here. Do NOT use open_app with task_instruction or start_gui_task for this kind of deterministic writing. Paths may use desktop/downloads/documents aliases or be absolute.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Target file path, e.g. "桌面/numbers.txt" or an absolute path.',
          },
          content: {
            type: 'string',
            description: 'Complete text content to write.',
          },
          open: {
            type: 'boolean',
            description:
              'Open the file with its default app after writing. Default true.',
          },
          overwrite: {
            type: 'boolean',
            description:
              'Replace an existing file. Only set true after the user agrees to overwrite.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_coding_task',
      description:
        'Start a coding task with the coding agent. Use for code files and scripts as well as repository work: create or edit code, implement an algorithm, fix a bug, write/run tests. Do NOT use for ordinary non-code text files, opening apps, web search, or GUI interaction. The agent works inside the configured demo workspace and asks before running shell commands.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'Self-contained coding instruction, including the expected files, behavior, and test command when known.',
          },
          workspace: {
            type: 'string',
            description:
              'Optional workspace. Omit to use the configured CYRVIS-demo workspace.',
          },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_coding_status',
      description:
        'Get the current coding task status, last message, result, and git diff summary.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_coding_task',
      description: 'Cancel the running coding task and stop its agent process.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_site',
      description:
        'Open a known website (Bilibili, Taobao, JD, YouTube, Zhihu, Weibo, Xiaohongshu, Baidu, Google, Bing, GitHub) for bare navigation requests like "打开B站/打开淘宝/打开YouTube". Do NOT use search_web or GUI clicking for these. If the user also wants a search inside the site ("打开B站搜一下猫"), set query. If they want you to interact with the page afterwards, set task_instruction.',
      parameters: {
        type: 'object',
        properties: {
          site: {
            type: 'string',
            description:
              'Site id, alias, Chinese name, or domain, e.g. bilibili, B站, 淘宝, YouTube, github.com.',
          },
          query: {
            type: 'string',
            description:
              'Optional on-site search query, e.g. "猫" for "打开B站搜一下猫".',
          },
          task_instruction: {
            type: 'string',
            description:
              'Optional GUI task to start after the page opens, e.g. "在B站搜索并播放第一个视频".',
          },
        },
        required: ['site'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_update_plan',
      description:
        'Update the travel-plan basic framework (destination, origin, dates, companions, budget, purpose, transport). Use for trip/flight/hotel planning chat. Ask only missing required fields, then offer a skeleton guide. Do NOT call start_gui_task for planning.',
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string' },
          origin: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          companions: { type: 'string' },
          budget: { type: 'string' },
          purpose: { type: 'string' },
          transport: { type: 'string' },
          user_text: {
            type: 'string',
            description: 'Raw user utterance to help fill slots.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_get_plan',
      description:
        'Get the current travel plan phase, missing slots, and speak hint.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_confirm_skeleton',
      description:
        'After required framework fields are filled, confirm the skeleton. If preference is unknown, this points you to travel_probe_highlights first.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_probe_highlights',
      description:
        'After the basic framework is ready, search the destination+dates and return ONE highlight per major category (food, viral check-in, classic landmark, local experience). Then ask which category the user prefers. Do not list many trivia items.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_set_preference',
      description:
        'Record the user travel preference after probing (food / checkin / landmark / experience). Runtime immediately returns a concrete Day1/Day2 plan with named places — speak that plan; do not ask a constraint card first; do not only promise to organize later.',
      parameters: {
        type: 'object',
        properties: {
          interest: {
            type: 'string',
            description:
              'food | checkin | landmark | experience, or Chinese like 美食/网红打卡/经典必去/当地体验',
          },
          notes: { type: 'string' },
        },
        required: ['interest'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_set_constraints',
      description:
        'Optional pace notes (walking / early starts / queues). Runtime soft-defaults and returns an executable plan — speak the plan first; keep pace as a short aside, never dump JSON.',
      parameters: {
        type: 'object',
        properties: {
          ok_with_walking: { type: 'boolean' },
          ok_with_early_start: { type: 'boolean' },
          ok_with_queues: { type: 'boolean' },
          notes: { type: 'string' },
          user_text: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_expand_aspect',
      description:
        'Expand one travel aspect. First call: speak 2-3 named options WITHOUT URLs. Only after the user confirms (选1 / option name) pass that confirmation in notes and then include that one booking link. For 门票/酒店 always with_search=false; never GUI-book. For 行程 speak concrete Day1/Day2 places.',
      parameters: {
        type: 'object',
        properties: {
          aspect: {
            type: 'string',
            description:
              'accommodation | daily_itinerary | tickets | budget_booking | emergency, or Chinese labels like 住宿/每日行程.',
          },
          notes: {
            type: 'string',
            description:
              'User confirmation only, e.g. 选1 / 三里屯. Do not put expand requests here.',
          },
          with_search: {
            type: 'boolean',
            description:
              'Must be false for tickets/hotels. Avoid true before the user confirms an option (URLs must not appear early).',
          },
        },
        required: ['aspect'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_search',
      description:
        'Search travel-related info for the current plan (flights, hotels, attractions). Include destination month/festival context when relevant.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          aspect: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_decline_expand',
      description:
        'Softly pause further expansion for now. Keep the skeleton/memos; invite the user to add more later. Optionally followed by travel_finalize_plan.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'travel_finalize_plan',
      description:
        'Write+open a styled desktop HTML travel plan page. After success, only tell the user the page is ready on the desktop—never read the full plan aloud.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];
