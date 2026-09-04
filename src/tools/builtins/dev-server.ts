import type { Tool, ToolOutcome, ToolOutcomeCode, ToolOutcomeStatus } from '../types.js';
import {
  DevServerManagerError,
  getDevServerStatus,
  readDevServerLogs,
  startDevServer,
  stopDevServer,
} from '../../runtime/dev-server-manager.js';

function result(status: ToolOutcomeStatus, code: ToolOutcomeCode, payload: unknown): ToolOutcome {
  return { status, code, retryable: false, output: JSON.stringify(payload, null, 2) };
}

function invalid(message: string): ToolOutcome {
  return result('error', 'INVALID_ARGUMENTS', { error: message });
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function failure(error: unknown): ToolOutcome {
  if (error instanceof DevServerManagerError) {
    const status: ToolOutcomeStatus =
      error.code === 'SANDBOX_DENIED' ? 'denied' : error.code === 'ABORTED' ? 'aborted' : 'error';
    return result(status, error.code, { error: error.message });
  }
  return result('error', 'EXECUTION_ERROR', {
    error: error instanceof Error ? error.message : String(error),
  });
}

export const devServerTool: Tool = {
  name: 'dev_server',
  description:
    'Manage long-running background processes such as a frontend dev server. Unlike run_command, ' +
    'the process keeps running across tool calls, so you can start a server, then inspect it with the browser tool.\n' +
    'Actions: start (needs command; optional readyUrl or readyPattern to wait until it actually serves), ' +
    'status (all servers, or one by id), logs (tail output; pass offset for incremental reads), stop (terminate the process tree).\n' +
    'Always stop servers you started once you are done verifying.',
  risk: 'dangerous',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'logs', 'stop'],
        description: 'Operation to perform',
      },
      id: { type: 'string', description: 'Server id returned by start (required for logs/stop)' },
      command: { type: 'string', description: 'Command to run for action=start, e.g. "npm run dev"' },
      cwd: { type: 'string', description: 'Working directory inside the workspace (default: workspace root)' },
      readyUrl: {
        type: 'string',
        description:
          'Wait until this loopback URL responds, e.g. http://localhost:5173. Only localhost/127.0.0.1/::1 allowed.',
      },
      readyPattern: {
        type: 'string',
        description: 'Wait until server output matches this case-insensitive regex, e.g. "ready in|listening on"',
      },
      timeoutMs: { type: 'integer', description: 'Readiness wait budget in ms (default 30000, max 180000)' },
      offset: { type: 'integer', description: 'Byte offset for action=logs (default: tail)' },
      limit: { type: 'integer', description: 'Max bytes for action=logs (default 8000, max 64000)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolOutcome> {
    const action = String(args.action);
    try {
      if (action === 'start') {
        const command = optionalString(args, 'command');
        if (!command) return invalid('action=start requires a non-empty command.');
        const started = await startDevServer({
          command,
          cwd: optionalString(args, 'cwd'),
          readyUrl: optionalString(args, 'readyUrl'),
          readyPattern: optionalString(args, 'readyPattern'),
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        });
        return result('success', 'OK', started);
      }

      if (action === 'status') {
        return result('success', 'OK', { servers: getDevServerStatus(optionalString(args, 'id')) });
      }

      if (action === 'logs') {
        const id = optionalString(args, 'id');
        if (!id) return invalid('action=logs requires the server id.');
        const logs = await readDevServerLogs(id, {
          ...(args.offset === undefined ? {} : { offset: Number(args.offset) }),
          ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
        });
        return result('success', 'OK', logs);
      }

      if (action === 'stop') {
        const id = optionalString(args, 'id');
        if (!id) return invalid('action=stop requires the server id.');
        return result('success', 'OK', await stopDevServer(id));
      }

      return invalid(`Unsupported action: ${action}`);
    } catch (error) {
      return failure(error);
    }
  },
};
