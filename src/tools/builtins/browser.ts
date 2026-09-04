import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { jailResolve } from '../../sandbox/index.js';
import { MAX_INLINE_BYTES_DEFAULT } from '../../attachments/image.js';
import type { Tool, ToolOutcome, ToolOutcomeCode, ToolOutcomeStatus } from '../types.js';
import {
  BrowserManagerError,
  click,
  closeAllBrowsers,
  closeSession,
  fill,
  listSessions,
  navigate,
  openSession,
  press,
  readText,
  screenshot,
  waitFor,
} from '../../runtime/browser-manager.js';

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
  if (error instanceof BrowserManagerError) {
    const status: ToolOutcomeStatus = error.code === 'SANDBOX_DENIED' ? 'denied' : 'error';
    return result(status, error.code, { error: error.message });
  }
  return result('error', 'EXECUTION_ERROR', {
    error: error instanceof Error ? error.message : String(error),
  });
}

export const browserTool: Tool = {
  name: 'browser',
  description:
    'Drive a real Chromium browser to inspect a running frontend. Sessions persist across tool calls, ' +
    'so open once and then navigate, interact, and screenshot the same page.\n' +
    'Actions: open, navigate, click, fill, press, wait_for, text, screenshot, console, list, close.\n' +
    'screenshot returns the rendered page as visual input, so you can actually see layout and styling issues. ' +
    'Every result also reports recent console messages, page errors, and failed requests.\n' +
    'Start the app with dev_server first. Only localhost URLs are allowed by default.',
  risk: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'open',
          'navigate',
          'click',
          'fill',
          'press',
          'wait_for',
          'text',
          'screenshot',
          'console',
          'list',
          'close',
        ],
        description: 'Operation to perform',
      },
      sessionId: { type: 'string', description: 'Session from action=open; optional when only one session exists' },
      url: { type: 'string', description: 'Target URL for action=navigate, e.g. http://localhost:5173' },
      selector: { type: 'string', description: 'CSS selector for click/fill/press/wait_for/text/screenshot' },
      value: { type: 'string', description: 'Text to type for action=fill' },
      key: { type: 'string', description: 'Key for action=press, e.g. Enter' },
      fullPage: { type: 'boolean', description: 'Capture the entire scrollable page (action=screenshot)' },
      headed: { type: 'boolean', description: 'Show a visible browser window on action=open (default: headless)' },
      path: { type: 'string', description: 'Optional PNG path inside the workspace to also save a screenshot' },
      detail: {
        type: 'string',
        enum: ['auto', 'low', 'high'],
        description: 'Vision detail level for screenshots (default: high)',
      },
      timeoutMs: { type: 'integer', description: 'Action timeout in ms (default 15000, max 60000)' },
      limit: { type: 'integer', description: 'Max characters for action=text (default 4000)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args): Promise<ToolOutcome> {
    const action = String(args.action);
    const sessionId = optionalString(args, 'sessionId');
    try {
      switch (action) {
        case 'open':
          return result('success', 'OK', await openSession({ headed: args.headed === true }));

        case 'list':
          return result('success', 'OK', { sessions: listSessions() });

        case 'navigate': {
          const url = optionalString(args, 'url');
          if (!url) return invalid('action=navigate requires a url.');
          return result(
            'success',
            'OK',
            await navigate({
              ...(sessionId ? { sessionId } : {}),
              url,
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
            }),
          );
        }

        case 'click':
        case 'wait_for': {
          const selector = optionalString(args, 'selector');
          if (!selector) return invalid(`action=${action} requires a selector.`);
          const opts = {
            ...(sessionId ? { sessionId } : {}),
            selector,
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
          };
          return result('success', 'OK', action === 'click' ? await click(opts) : await waitFor(opts));
        }

        case 'fill': {
          const selector = optionalString(args, 'selector');
          if (!selector) return invalid('action=fill requires a selector.');
          if (typeof args.value !== 'string') return invalid('action=fill requires a value string.');
          return result(
            'success',
            'OK',
            await fill({
              ...(sessionId ? { sessionId } : {}),
              selector,
              value: args.value,
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
            }),
          );
        }

        case 'press': {
          const key = optionalString(args, 'key');
          if (!key) return invalid('action=press requires a key.');
          return result(
            'success',
            'OK',
            await press({
              ...(sessionId ? { sessionId } : {}),
              key,
              ...(optionalString(args, 'selector') ? { selector: optionalString(args, 'selector') as string } : {}),
              ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
            }),
          );
        }

        case 'text':
          return result(
            'success',
            'OK',
            await readText({
              ...(sessionId ? { sessionId } : {}),
              ...(optionalString(args, 'selector') ? { selector: optionalString(args, 'selector') as string } : {}),
              ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
            }),
          );

        case 'console': {
          const sessions = listSessions();
          const shot = await readText({ ...(sessionId ? { sessionId } : {}), limit: 100 });
          return result('success', 'OK', {
            sessionId: shot.sessionId,
            url: shot.url,
            diagnostics: shot.diagnostics,
            openSessions: sessions.length,
          });
        }

        case 'screenshot': {
          const captured = await screenshot({
            ...(sessionId ? { sessionId } : {}),
            fullPage: args.fullPage === true,
            ...(optionalString(args, 'selector') ? { selector: optionalString(args, 'selector') as string } : {}),
            ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
          });
          const { buffer, ...meta } = captured;

          if (buffer.byteLength > MAX_INLINE_BYTES_DEFAULT) {
            return result('error', 'EXECUTION_ERROR', {
              error: `Screenshot is ${buffer.byteLength} bytes, above the ${MAX_INLINE_BYTES_DEFAULT} byte inline limit. Retry with fullPage=false or a narrower selector.`,
              ...meta,
            });
          }

          let savedPath: string | undefined;
          const requestedPath = optionalString(args, 'path');
          if (requestedPath) {
            if (extname(requestedPath).toLowerCase() !== '.png') {
              return invalid('path must use the .png extension.');
            }
            try {
              const absolute = jailResolve(requestedPath);
              await mkdir(dirname(absolute), { recursive: true });
              await writeFile(absolute, buffer);
              savedPath = requestedPath;
            } catch (error) {
              return result('denied', 'SANDBOX_DENIED', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          const detail = args.detail === 'low' || args.detail === 'auto' ? args.detail : 'high';
          return {
            status: 'success',
            code: 'OK',
            retryable: false,
            output: JSON.stringify(
              {
                ...meta,
                bytes: buffer.byteLength,
                ...(savedPath ? { savedPath } : {}),
                note: 'Rendered page is attached to the next model request.',
              },
              null,
              2,
            ),
            modelAttachments: [
              {
                type: 'image',
                name: `${meta.sessionId}.png`,
                mime: 'image/png',
                dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
                detail,
              },
            ],
          };
        }

        case 'close': {
          if (!sessionId && listSessions().length > 1) {
            await closeAllBrowsers();
            return result('success', 'OK', { closed: 'all' });
          }
          return result('success', 'OK', await closeSession(sessionId));
        }

        default:
          return invalid(`Unsupported action: ${action}`);
      }
    } catch (error) {
      return failure(error);
    }
  },
};
