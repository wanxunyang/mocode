import { lstatSync, readFileSync } from 'node:fs';
import { contentHash } from '../changeset/hash.js';
import type { ContentHash } from '../changeset/types.js';
import type { ToolCallRef } from '../llm/index.js';
import type { ToolOutcome } from '../tools/types.js';
import type { AgentRuntimeContext } from './runtime-context.js';
import { parseArgs } from './tool-helpers.js';

// 只接受明确、完整的字面量替换请求。命令仍由模型经正常权限和工具流程调用。
const ZH =
  /^将 ?`(?<file>[^`\r\n]+)` ?中的 ?`(?<oldText>[^`\r\n]+)` ?替换为 ?`(?<newText>[^`\r\n]*)`。(?:然后运行 ?`(?<command>[^`\r\n]+)`|无需运行检查)。?$/u;
const EN =
  /^Replace `(?<oldText>[^`\r\n]+)` with `(?<newText>[^`\r\n]*)` in `(?<file>[^`\r\n]+)`\. (?:Then run `(?<command>[^`\r\n]+)`|No checks needed)\.?$/iu;
const MAX_EDIT_BYTES = 256 * 1024;

type FallbackReason =
  | 'opening_missing'
  | 'tool_failed'
  | 'unexpected_tool'
  | 'edit_unproven'
  | 'verification_mismatch'
  | 'workspace_changed'
  | 'user_update'
  | 'turn_state_changed'
  | 'model_finished';

export function createShortPathCompletion(input: string, ctx: AgentRuntimeContext) {
  const text = input.trim();
  const zh = ZH.exec(text);
  const match = zh ?? EN.exec(text);
  if (!match?.groups) return;
  const { file, oldText, newText, command } = match.groups;
  if (oldText === newText) return;

  let edit: { path: string; hash: ContentHash } | undefined;
  let verified = false;
  let fallback: FallbackReason | undefined;

  const resolve = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return;
    try {
      return ctx.jailResolve(value);
    } catch {
      return;
    }
  };

  return {
    get fallback() {
      return fallback;
    },
    reject(reason: FallbackReason): void {
      fallback ??= reason;
    },
    observe(call: ToolCallRef, outcome: ToolOutcome): void {
      if (fallback) return;
      if (outcome.status !== 'success') {
        fallback = 'tool_failed';
        return;
      }
      const args = parseArgs(call.arguments);
      if (!edit && call.name === 'read_file' && !outcome.modelAttachments?.length) {
        const target = resolve(file);
        if (target && target === resolve(args?.path)) return;
      }
      if (!edit && call.name === 'edit_file') {
        const target = resolve(file);
        const change = outcome.changeSet?.changes[0];
        if (
          target &&
          target === resolve(args?.path) &&
          args?.old_string === oldText &&
          args?.new_string === newText &&
          outcome.exactTextReplacement &&
          outcome.changeSet?.changes.length === 1 &&
          change?.operation === 'update' &&
          change.beforeHash &&
          change.afterHash &&
          target === resolve(change.path)
        ) {
          edit = { path: target, hash: change.afterHash };
        } else {
          fallback = 'edit_unproven';
        }
        return;
      }
      if (edit && command && call.name === 'run_command') {
        if (
          args?.command === command &&
          args.shell === undefined &&
          outcome.code === 'OK' &&
          !outcome.changedFiles?.length
        ) {
          verified = true;
        } else {
          fallback = 'verification_mismatch';
        }
        return;
      }
      fallback = 'unexpected_tool';
    },
    finalText(): string | undefined {
      if (fallback || !edit || (command && !verified)) return;
      const changes = ctx.getCurrentTurnMutationState().changedFiles;
      if (changes.length !== 1 || resolve(changes[0].path) !== edit.path || resolve(file) !== edit.path) {
        fallback = 'workspace_changed';
        return;
      }
      try {
        const info = lstatSync(edit.path);
        if (!info.isFile() || info.size > MAX_EDIT_BYTES || contentHash(readFileSync(edit.path)) !== edit.hash) {
          fallback = 'workspace_changed';
          return;
        }
      } catch {
        fallback = 'workspace_changed';
        return;
      }
      const target = '`' + file + '`';
      if (zh) return command ? `已在${target}完成替换，指定检查已通过。` : `已在${target}完成替换。`;
      return command ? `Updated ${target}. The requested check passed.` : `Updated ${target}.`;
    },
  };
}
