import type OpenAI from 'openai';
import {
  ADD_TOOL_GROUPS_TOOL_NAME,
  COMMON_TOOL_NAMES,
  TOOL_ROUTE_GROUP_NAMES,
  TOOL_ROUTE_GROUPS,
  getToolRouteGroupNames,
  isToolRouteGroupName,
  type ToolRouteGroupName,
} from '../config/profiles.js';
import { PLAN_DISABLED_TOOLS } from './constants.js';
import { tools } from './registry.js';

export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ToolPolicySnapshot {
  id: string;
  version: number;
  groups: ReadonlySet<ToolRouteGroupName>;
  allowedNames: ReadonlySet<string>;
  tools: ChatTool[];
  reason: string;
  confidence: number;
  planMode: boolean;
}

export interface ToolPolicyExpansion {
  added: ToolRouteGroupName[];
  rejected: string[];
  snapshot: ToolPolicySnapshot;
}

export interface ToolPolicyInit {
  groups?: Iterable<ToolRouteGroupName>;
  reason?: string;
  confidence?: number;
  id?: string;
  maxExpansions?: number;
}

const clampConfidence = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

function envGateAllows(name: string | undefined): boolean {
  return !name || process.env[name] !== 'false';
}

function registeredNames(): string[] {
  return tools.map((tool) => tool.name);
}

/** 当前进程真正可路由的簇；旧 env=false 只作为硬 veto，不再强制把簇常驻 schema。 */
export function getAvailableToolRouteGroups(): ToolRouteGroupName[] {
  const names = registeredNames();
  const registered = new Set(names);
  return TOOL_ROUTE_GROUP_NAMES.filter((group) => {
    const definition = TOOL_ROUTE_GROUPS[group];
    if (!envGateAllows(definition.gateEnv)) return false;
    const groupNames = getToolRouteGroupNames(group, names);
    if (group === 'mcp') return groupNames.length > 0;
    return groupNames.length > 0 && groupNames.every((name) => registered.has(name));
  });
}

export function toolRouteCatalog(groups: readonly ToolRouteGroupName[] = getAvailableToolRouteGroups()): string {
  const names = registeredNames();
  return groups
    .map((group) => {
      const members = getToolRouteGroupNames(group, names);
      return `- ${group}: ${TOOL_ROUTE_GROUPS[group].description} Tools: ${members.join(', ') || '(dynamic MCP tools)'}.`;
    })
    .join('\n');
}

export function getToolChatSchema(name: string): ChatTool | null {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return null;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as OpenAI.FunctionParameters,
    },
  };
}

function addToolGroupsSchema(groups: readonly ToolRouteGroupName[]): ChatTool {
  return {
    type: 'function',
    function: {
      name: ADD_TOOL_GROUPS_TOOL_NAME,
      description:
        'Expand the tool surface for this turn when the current tools are insufficient. Call this tool ALONE, before any dependent tool call. Added groups become available on the next model step and cannot be removed during the turn.',
      parameters: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            items: { type: 'string', enum: [...groups] },
            minItems: 1,
            // 不用 uniqueItems:kimi-k3@dashscope 等服务端对含该关键字的工具 schema 整请求 400
            // (InternalError.Algo: Invalid request parameters)。去重语义写进 description,
            // 且 expand() 本身对重复组幂等(已激活的直接 rejected),不依赖 schema 约束。
            description: 'Additional capability groups needed to complete the current task. Do not repeat a group.',
          },
          reason: {
            type: 'string',
            description: 'Concise evidence-based reason these capabilities are now required.',
          },
        },
        required: ['groups', 'reason'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * 一个用户 turn 独享的版本化工具策略。每次扩容生成新 snapshot；已发出的模型请求继续用
 * 旧 snapshot 校验其 tool_calls，因此 schema 与执行 backstop 永远同源。
 */
export class ToolPolicyController {
  readonly id: string;
  private readonly selected = new Set<ToolRouteGroupName>();
  private readonly maxExpansions: number;
  private expansionCount = 0;
  private version = 1;
  private reason: string;
  private confidence: number;
  private autoCache: ToolPolicySnapshot | null = null;
  private planCache: ToolPolicySnapshot | null = null;

  constructor(init: ToolPolicyInit = {}) {
    this.id = init.id ?? `route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.maxExpansions = Math.max(0, init.maxExpansions ?? 3);
    this.reason = init.reason?.trim() || 'LLM router selected common tools only.';
    this.confidence = clampConfidence(init.confidence ?? 0);
    const available = new Set(getAvailableToolRouteGroups());
    const requested = process.env.MOCODE_TOOL_POLICY === 'full' ? available : new Set(init.groups ?? []);
    for (const group of requested) {
      if (available.has(group)) this.selected.add(group);
    }
  }

  get groupNames(): ToolRouteGroupName[] {
    return TOOL_ROUTE_GROUP_NAMES.filter((group) => this.selected.has(group));
  }

  get canExpand(): boolean {
    return this.expansionCount < this.maxExpansions && this.remainingGroups().length > 0;
  }

  remainingGroups(): ToolRouteGroupName[] {
    const available = new Set(getAvailableToolRouteGroups());
    return TOOL_ROUTE_GROUP_NAMES.filter((group) => available.has(group) && !this.selected.has(group));
  }

  snapshot(planMode = false): ToolPolicySnapshot {
    const cached = planMode ? this.planCache : this.autoCache;
    if (cached) return cached;

    const orderedNames: string[] = [];
    const seen = new Set<string>();
    const append = (name: string): void => {
      if (!seen.has(name)) {
        seen.add(name);
        orderedNames.push(name);
      }
    };
    for (const name of COMMON_TOOL_NAMES) append(name);
    const remaining = this.canExpand ? this.remainingGroups() : [];
    if (remaining.length > 0) append(ADD_TOOL_GROUPS_TOOL_NAME);
    const registered = registeredNames();
    for (const group of TOOL_ROUTE_GROUP_NAMES) {
      if (!this.selected.has(group)) continue;
      for (const name of getToolRouteGroupNames(group, registered)) append(name);
    }

    const visibleNames = planMode
      ? orderedNames.filter(
          (name) => name === ADD_TOOL_GROUPS_TOOL_NAME || (!PLAN_DISABLED_TOOLS.has(name) && !name.startsWith('mcp__')),
        )
      : orderedNames;
    const chatTools = visibleNames.flatMap((name) => {
      if (name === ADD_TOOL_GROUPS_TOOL_NAME) return [addToolGroupsSchema(remaining)];
      const schema = getToolChatSchema(name);
      return schema ? [schema] : [];
    });
    const snapshot: ToolPolicySnapshot = {
      id: this.id,
      version: this.version,
      groups: new Set(this.groupNames),
      allowedNames: new Set(chatTools.map((tool) => tool.function.name)),
      tools: chatTools,
      reason: this.reason,
      confidence: this.confidence,
      planMode,
    };
    if (planMode) this.planCache = snapshot;
    else this.autoCache = snapshot;
    return snapshot;
  }

  expand(rawGroups: readonly unknown[], reason: string): ToolPolicyExpansion {
    const rejected: string[] = [];
    const added: ToolRouteGroupName[] = [];
    if (this.expansionCount >= this.maxExpansions) {
      return {
        added,
        rejected: ['expansion limit reached'],
        snapshot: this.snapshot(false),
      };
    }
    const available = new Set(getAvailableToolRouteGroups());
    for (const value of rawGroups) {
      if (!isToolRouteGroupName(value)) {
        rejected.push(`${String(value)}: unknown group`);
      } else if (!available.has(value)) {
        rejected.push(`${value}: capability disabled or unavailable`);
      } else if (this.selected.has(value)) {
        rejected.push(`${value}: already active`);
      } else {
        this.selected.add(value);
        added.push(value);
      }
    }
    if (added.length > 0) {
      this.expansionCount++;
      this.version++;
      this.reason = reason.trim() || `Main agent added ${added.join(', ')}.`;
      this.confidence = Math.max(this.confidence, 0.8);
      this.autoCache = null;
      this.planCache = null;
    }
    return { added, rejected, snapshot: this.snapshot(false) };
  }

  /** 注入请求尾部，不改写稳定 system prefix。 */
  reminder(planMode = false): string {
    const snapshot = this.snapshot(planMode);
    const active = this.groupNames.length ? this.groupNames.join(', ') : '(common only)';
    const remaining = this.remainingGroups();
    const lines = [
      '## Tool route (current turn)',
      `Policy ${snapshot.id} v${snapshot.version}; active groups: ${active}.`,
      `Router reason: ${snapshot.reason}`,
      'Use only the tools currently exposed. If a required capability is missing, call add_tool_groups alone; dependent calls must wait until the next step.',
    ];
    if (remaining.length) lines.push(`Groups still available: ${remaining.join(', ')}.`);
    if (this.selected.has('computer-control')) {
      lines.push(
        'Computer control: the computer tool drives the real desktop and returns a fresh screenshot after every action; inspect it before acting again and self-correct.',
        'Coordinates use a normalized 0-1000 grid. Zoom into tight regions before clicking small or dense targets.',
        'Require explicit user intent before destructive or sensitive targets such as submit, payment, credentials, delete, or send; every action still passes the permission gate.',
      );
    }
    if (this.selected.has('memory-read')) {
      lines.push(
        'Memory read: use memory_search for relevant cross-session facts and memory_list only when an index overview is needed; memory_search may also return graph relations.',
      );
    }
    if (this.selected.has('memory-write')) {
      lines.push(
        'Memory write: persist only stable, non-obvious cross-session facts. Search before saving, update instead of duplicating, and archive stale entries; add graph links only when meaningful.',
      );
    }
    return lines.join('\n');
  }
}
