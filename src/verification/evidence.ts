import type { ToolOutcome } from '../tools/types.js';

const VALIDATION_COMMAND =
  /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|typecheck|lint|build)(?: --workspace [@\w./-]+)?|node --test(?: [\w./-]+)*|node (?:[\w./-]+\/)?verify[\w.-]*\.(?:[cm]?js))$/;
const PRESERVES_EVIDENCE = new Set(['read_file', 'grep', 'glob', 'plan_update', 'note_append']);
const MAX_CHECKS = 3;

/** Advisory evidence for one turn. Commands still execute normally if the agent requests a rerun. */
export function createVerificationEvidence() {
  const passed = new Map<string, string>();
  let edited = false;
  let pending = false;

  const invalidate = (): void => {
    passed.clear();
    pending = false;
  };

  return {
    invalidate,
    observe(tool: string, args: Record<string, unknown> | null, outcome: ToolOutcome): void {
      if (outcome.changedFiles?.length || outcome.changeSet?.changes.length || outcome.staleFiles?.length) {
        invalidate();
        if (outcome.status === 'success' && (tool === 'edit_file' || tool === 'write_file')) edited = true;
        return;
      }
      if (!edited || PRESERVES_EVIDENCE.has(tool)) return;
      const command = tool === 'run_command' && typeof args?.command === 'string' ? args.command.trim() : '';
      if (command.length > 160 || !VALIDATION_COMMAND.test(command)) {
        invalidate();
        return;
      }
      const shell = typeof args?.shell === 'string' ? args.shell : '';
      const key = JSON.stringify([command, shell]);
      if (outcome.status !== 'success' || outcome.code !== 'OK') {
        passed.delete(key);
        return;
      }
      passed.delete(key);
      passed.set(key, shell ? `${command} (shell: ${shell})` : command);
      if (passed.size > MAX_CHECKS) passed.delete(passed.keys().next().value!);
      pending = true;
    },
    takeReminder(): string | undefined {
      if (!pending || !passed.size) return;
      pending = false;
      return [
        '## Validation evidence for the current edits',
        ...[...passed.values()].map((command) => `- Passed: \`${command}\``),
        'If these checks cover the requested outcomes and their inputs and environment have not changed, use the results above and finish. Run any gaps, explicitly requested fresh checks, or checks invalidated by a change.',
      ].join('\n');
    },
  };
}
