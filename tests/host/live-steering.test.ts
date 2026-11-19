import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

test('public host accepts a live multimodal update without starting another run', { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mocode-live-host-'));
  const workspace = path.join(root, 'workspace');
  const userDir = path.join(root, 'user');
  mkdirSync(workspace);
  mkdirSync(userDir);
  const events: Array<{ event?: string; type?: string; payload?: Record<string, unknown> }> = [];
  const requests: Array<{ role: string; content: unknown }[]> = [];
  let held: http.ServerResponse | undefined;
  const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data) => {
      body += data;
    });
    req.on('end', () => {
      requests.push(JSON.parse(body).messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requests.length === 1) {
        held = res;
        res.write(frame('working'));
      } else if (requests.length === 2) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'steered-tool', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(frame('updated'));
        res.end('data: [DONE]\n\n');
      } else {
        res.write(frame('done'));
        res.end('data: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const repo = process.cwd();
  const entry = process.env.MOCODE_STEERING_TEST_HOST;
  const args = entry
    ? [path.resolve(entry)]
    : [
        '--import',
        pathToFileURL(path.join(repo, 'node_modules/tsx/dist/esm/index.mjs')).href,
        path.join(repo, 'src/host/stdio.ts'),
      ];
  if (entry) assert.ok(existsSync(entry));
  const child = spawn(process.execPath, args, {
    cwd: workspace,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: userDir,
      USERPROFILE: userDir,
      LLM_PROVIDER: 'openai',
      LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      LLM_API_KEY: 'fixture',
      LLM_MODEL: 'fixture',
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
  });
  let buffer = '';
  let diagnostics = '';
  const send = (prompt: string, attachments?: unknown[]) =>
    child.stdin.write(JSON.stringify({ type: 'run', id: 'live', prompt, attachments }) + '\n');
  child.stderr.on('data', (data) => {
    diagnostics += data;
  });
  child.stdout.on('data', (data) => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === 'runtime_ready') send('implement the login page');
        if (event.event === 'text_delta' && event.payload.text === 'working')
          send('use Chinese and add captcha', [
            { name: 'requirements.txt', text: 'captcha must have a refresh button' },
          ]);
        if (event.event === 'message_received') held?.end('data: [DONE]\n\n');
      } catch {
        /* Ignore non-protocol diagnostics. */
      }
    }
  });
  try {
    const deadline = Date.now() + 25000;
    while (!events.some((event) => event.event === 'run_completed')) {
      assert.ok(Date.now() < deadline, JSON.stringify(events) + diagnostics);
      assert.equal(
        events.some((event) => event.type === 'error' || event.event === 'run_failed'),
        false,
        JSON.stringify(events),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(events.filter((event) => event.event === 'run_started').length, 1);
    assert.equal(events.filter((event) => event.event === 'message_received').length, 1);
    assert.equal(requests.length, 3);
    const openingIndex = events.findIndex((event) => event.event === 'text_delta' && event.payload?.text === 'updated');
    const preparingIndex = events.findIndex(
      (event) => event.event === 'status' && event.payload?.value === 'preparing_tool',
    );
    const toolIndex = events.findIndex(
      (event) => event.event === 'tool_started' && event.payload?.id === 'steered-tool',
    );
    assert.ok(openingIndex >= 0 && openingIndex < preparingIndex && preparingIndex < toolIndex);
    const reminders = requests[1]
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content))
      .join('\n');
    assert.match(reminders, /same ongoing task/);
    assert.match(reminders, /original request and all subsequent user updates together/);
    assert.match(reminders, /preserving earlier requirements/);
    assert.match(reminders, /continue from the current progress/);
    assert.match(reminders, /## Steering opening/);
    assert.ok(!requests[2].some((message) => String(message.content).includes('## Steering opening')));
    assert.match(reminders, /explicitly asks to cancel, stop, or switch tasks/);
    assert.equal(
      requests[0].some((message) => String(message.content).includes('## Live user updates')),
      false,
    );
    const users = requests[1].filter((message) => message.role === 'user');
    assert.equal(users[0].content, 'implement the login page');
    assert.match(JSON.stringify(users[1].content), /use Chinese and add captcha/);
    assert.match(JSON.stringify(users[1].content), /captcha must have a refresh button/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    held?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
