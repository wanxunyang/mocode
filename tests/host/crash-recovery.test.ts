import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRecovery, recoveryLog } from '../../packages/work-app/src/recovery-log.js';

type Envelope = { type: string; event?: string; requestId?: string; payload?: Record<string, unknown>; error?: string };
type Message = { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] };
type SessionRecord = { history: Message[]; queryHistory?: string[] };

const repoRoot = fs.existsSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src', 'host', 'stdio.ts'),
)
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const recoveredEvents = new Set([
  'run_started',
  'text_delta',
  'tool_started',
  'tool_output',
  'tool_completed',
  'live_usage',
  'no_reply',
  'max_steps',
  'approval_requested',
  'run_aborted',
  'run_completed',
  'run_failed',
  'host_exit',
]);

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      return typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
    })
    .join('');
}

function chunk(choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

function startHost(
  workspace: string,
  home: string,
  baseURL: string,
  events: Envelope[],
  diagnostics: string[],
  onEvent: (event: Envelope) => void,
): {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  send: (value: Record<string, unknown>) => void;
} {
  const sourceEntry = path.join(repoRoot, 'src', 'host', 'stdio.ts');
  const child = spawn(
    process.execPath,
    fs.existsSync(sourceEntry)
      ? [
          '--import',
          pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href,
          sourceEntry,
        ]
      : [path.join(repoRoot, 'dist', 'host', 'stdio.js')],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LLM_PROVIDER: 'openai',
        LLM_BASE_URL: baseURL,
        LLM_API_KEY: 'crash-recovery-test-key',
        LLM_MODEL: 'crash-recovery-test-model',
        LLM_STREAM_USAGE: 'false',
        MOCODE_ROUTER_ENABLED: 'false',
        MOCODE_PERMISSION: 'false',
        MOCODE_MCP_ENABLED: 'false',
        MOCODE_AUTO_GC: 'false',
        MEMORY_ENABLED: 'false',
        AUTO_REFLECT: 'false',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    buffered += data;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const envelope = JSON.parse(line) as Envelope;
        events.push(envelope);
        onEvent(envelope);
      } catch {
        diagnostics.push(`invalid host output: ${line}`);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    diagnostics.push(data);
    if (diagnostics.length > 30) diagnostics.splice(0, diagnostics.length - 30);
  });
  return {
    child,
    exited,
    send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
  };
}

async function waitForEvent(
  events: Envelope[],
  predicate: (event: Envelope) => boolean,
  diagnostics: string[],
  label: string,
): Promise<Envelope> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.\n${diagnostics.join('\n')}\nEvents: ${JSON.stringify(events)}`);
}

test('真实 host 强杀后保留工具检查点和半截 UI，重启续聊不重复用户轮也不重跑工具', { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-host-crash-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const events: Envelope[] = [];
  const diagnostics: string[] = [];
  const requests: Message[][] = [];
  const hungResponses: http.ServerResponse[] = [];
  let current: ReturnType<typeof startHost> | null = null;
  const log = recoveryLog(root, 'task-real');
  const record = (envelope: Envelope): void => {
    if (envelope.type === 'error' || (envelope.type === 'event' && recoveredEvents.has(envelope.event ?? '')))
      log.event(envelope);
  };

  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (data: string) => {
      body += data;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Message[] };
      requests.push(parsed.messages);
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      if (requests.length === 1) {
        response.write(chunk({ delta: { content: '崩溃前已经显示。' } }));
        response.write(
          chunk({
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-crash-real',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'crash-target.txt', content: 'checkpoint-content' }),
                  },
                },
              ],
            },
          }),
        );
        response.write(chunk({ delta: {}, finish_reason: 'tool_calls' }));
        response.end('data: [DONE]\n\n');
      } else if (requests.length === 2) {
        // 工具结果已提交，第二次模型响应只流出一半；此时直接杀掉 host。
        response.write(chunk({ delta: { content: '工具后的半截正文。' } }));
        hungResponses.push(response);
      } else {
        response.write(chunk({ delta: { content: '恢复后续聊成功。' } }));
        response.write(chunk({ delta: {}, finish_reason: 'stop' }));
        response.end('data: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseURL = `http://127.0.0.1:${address.port}/v1`;

  try {
    current = startHost(workspace, home, baseURL, events, diagnostics, record);
    await waitForEvent(events, (event) => event.event === 'runtime_ready', diagnostics, 'runtime_ready');
    const attachment = { name: 'before-crash.png', dataUrl: 'data:image/png;base64,AAAA' };
    const document = { name: 'before-crash.pdf', text: '崩溃前 PDF 附件正文', truncated: true };
    log.user('first crash prompt', [attachment, document]);
    current.send({ id: 'task-real', type: 'run', prompt: 'first crash prompt', attachments: [attachment, document] });
    const started = await waitForEvent(
      events,
      (event) => event.event === 'run_started' && event.requestId === 'task-real',
      diagnostics,
      'run_started',
    );
    const sessionId = started.payload?.sessionId;
    assert.equal(typeof sessionId, 'string');
    await waitForEvent(
      events,
      (event) => event.event === 'text_delta' && event.payload?.text === '工具后的半截正文。',
      diagnostics,
      'partial text after committed tool',
    );

    // SIGKILL 在 Windows 上走强制终止，不给 stdin 关闭或 finally 保存的机会。
    assert.equal(current.child.kill('SIGKILL'), true);
    await current.exited;
    current = null;
    record({ type: 'event', event: 'host_exit', requestId: 'task-real', payload: { code: null } });

    const sessionFile = path.join(workspace, '.mocode', 'sessions', sessionId as string, 'session.json');
    const crashed = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as SessionRecord;
    assert.equal(
      crashed.history.filter((message) => message.role === 'user' && textOf(message).includes('first crash prompt'))
        .length,
      1,
    );
    assert.equal(
      crashed.history.filter((message) => message.role === 'assistant' && message.tool_calls?.length).length,
      1,
    );
    const savedUser = crashed.history.find(
      (message) => message.role === 'user' && textOf(message).includes('first crash prompt'),
    );
    assert.ok(savedUser, '当前 run 的用户消息应在工具检查点里');
    assert.ok(
      Array.isArray(savedUser.content) &&
        savedUser.content.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            (part as { text?: unknown }).text?.toString().includes('崩溃前 PDF 附件正文'),
        ),
      `附件正文未保存：${JSON.stringify(crashed.history)}`,
    );
    const savedTool = crashed.history.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'call-crash-real',
    );
    assert.ok(savedTool, 'onCheckpoint 必须在工具提交后立即保存 tool result');
    assert.match(textOf(savedTool), /crash-target\.txt/);
    assert.equal(
      crashed.history.some((message) => textOf(message).includes('工具后的半截正文')),
      false,
      '半截 assistant 不能伪装成完整消息进入模型历史',
    );
    assert.equal(fs.readFileSync(path.join(workspace, 'crash-target.txt'), 'utf8'), 'checkpoint-content');

    const snapshot = readRecovery(root, 'task-real');
    assert.ok(snapshot);
    assert.equal(snapshot.interrupted, true);
    assert.equal(snapshot.pendingApproval, null);
    assert.equal(snapshot.items.filter((item) => item.kind === 'user').length, 1);
    assert.deepEqual(snapshot.items[0]?.kind === 'user' ? snapshot.items[0].attachments : [], [attachment, document]);
    assert.ok(snapshot.items.some((item) => item.kind === 'text' && item.text.includes('崩溃前已经显示')));
    assert.ok(snapshot.items.some((item) => item.kind === 'text' && item.text.includes('工具后的半截正文')));
    const restoredTool = snapshot.items.find((item) => item.kind === 'tool' && item.id === 'call-crash-real');
    assert.ok(restoredTool?.kind === 'tool');
    assert.equal(restoredTool.done, true);
    assert.equal(restoredTool.payload?.status, 'success');
    const requestsAfterCrash = requests.length;

    // 只启动 host 不能自动续跑模型或工具，必须等用户明确发送下一条消息。
    current = startHost(workspace, home, baseURL, events, diagnostics, record);
    await waitForEvent(
      events,
      (event) => event.event === 'runtime_ready' && events.indexOf(event) > events.indexOf(started),
      diagnostics,
      'restarted runtime_ready',
    );
    assert.equal(requests.length, requestsAfterCrash);
    log.user('continue-after-crash');
    current.send({ id: 'task-real', type: 'run', prompt: 'continue-after-crash', sessionId: sessionId as string });
    await waitForEvent(
      events,
      (event) => event.event === 'run_completed' && event.requestId === 'task-real',
      diagnostics,
      'continued run_completed',
    );

    assert.equal(requests.length, requestsAfterCrash + 1);
    const continuedRequest = requests.at(-1) ?? [];
    assert.equal(
      continuedRequest.filter((message) => message.role === 'user' && textOf(message).includes('first crash prompt'))
        .length,
      1,
    );
    assert.equal(
      continuedRequest.filter((message) => message.role === 'user' && textOf(message).includes('continue-after-crash'))
        .length,
      1,
    );
    assert.equal(
      continuedRequest.filter((message) => message.role === 'tool' && message.tool_call_id === 'call-crash-real')
        .length,
      1,
    );
    assert.ok(continuedRequest.some((message) => message.role === 'assistant' && message.tool_calls?.length));
    assert.equal(textOf(savedUser).includes('崩溃前 PDF 附件正文'), true);
    const requestUser = continuedRequest.find((message) => textOf(message).includes('first crash prompt'));
    assert.ok(requestUser && Array.isArray(requestUser.content));
    assert.equal(
      requestUser.content.some(
        (part) => part && typeof part === 'object' && (part as { name?: unknown }).name !== undefined,
      ),
      false,
      '回放元数据不得发给模型',
    );
    assert.equal(fs.readFileSync(path.join(workspace, 'crash-target.txt'), 'utf8'), 'checkpoint-content');

    const continued = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as SessionRecord;
    assert.deepEqual(continued.queryHistory, ['first crash prompt', 'continue-after-crash']);
    assert.equal(
      continued.history.filter((message) => message.role === 'user' && textOf(message).includes('first crash prompt'))
        .length,
      1,
    );
    assert.equal(
      continued.history.filter((message) => message.role === 'user' && textOf(message).includes('continue-after-crash'))
        .length,
      1,
    );
    assert.equal(
      continued.history.filter((message) => message.role === 'tool' && message.tool_call_id === 'call-crash-real')
        .length,
      1,
    );
    const continuedSnapshot = readRecovery(root, 'task-real');
    assert.ok(continuedSnapshot);
    assert.equal(
      continuedSnapshot.items.filter((item) => item.kind === 'tool' && item.id === 'call-crash-real').length,
      1,
    );
    assert.equal(continuedSnapshot.interrupted, false);
  } finally {
    if (current && current.child.exitCode === null && current.child.signalCode === null) {
      current.child.kill('SIGKILL');
      await current.exited;
    }
    for (const response of hungResponses) response.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
