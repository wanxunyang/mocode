// 任务结束通知：POST 到用户自配的 webhook，按 URL 自动识别格式：
// - ntfy：https://ntfy.sh/<topic>（POST 正文，Title header）
// - Bark：https://api.day.app/<key>（POST JSON {title, body}）
// - Telegram：https://api.telegram.org/bot<token>/sendMessage[?chat_id=...]
// - 其他：generic JSON webhook
//
// 刻意 best-effort：通知失败永不影响任务结果、不重试（webhook 是副作用通道，
// 不该因为通知服务挂了让 job 变 failed）。
//
// 回环地址（localhost/127.0.0.1）走 node:http 直连：Node 24 的 fetch 默认使用
// HTTP_PROXY 环境代理，而 NO_PROXY 对 localhost 的绕过不可靠，带代理的机器上
// 本地 webhook 会被转发失败。公网地址仍走 fetch（保留代理穿透）。

export interface NotifyEvent {
  status: 'succeeded' | 'failed';
  prompt: string;
  sessionId: string;
  elapsedMs: number;
  model: string;
}

function firstLine(prompt: string): string {
  const line = prompt.split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function buildTitle(ev: NotifyEvent): string {
  return `mocode ${ev.status === 'succeeded' ? 'OK' : 'FAILED'}`;
}

function buildBody(ev: NotifyEvent): string {
  const secs = (ev.elapsedMs / 1000).toFixed(1);
  return `${firstLine(ev.prompt)}\n\nsession: ${ev.sessionId}\nmodel: ${ev.model}\ntime: ${secs}s`;
}

/**
 * 按 URL 构造请求（纯函数）。
 * 返回 null 表示 URL 无法识别（调用方静默跳过）。
 */
export function buildNotifyRequest(webhookUrl: string, ev: NotifyEvent): { init: RequestInit } | null {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return null;
  }
  const title = buildTitle(ev);
  const body = buildBody(ev);

  // Telegram：query 中的 chat_id 合并进 JSON body。
  if (url.hostname === 'api.telegram.org' && url.pathname.includes('/sendMessage')) {
    const chatId = url.searchParams.get('chat_id') ?? process.env.MOCODE_NOTIFY_CHAT_ID;
    if (!chatId) return null;
    url.search = '';
    return {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `${title}\n${body}` }),
      },
    };
  }

  // Bark：{title, body}。
  if (url.hostname === 'api.day.app' || url.hostname.endsWith('.day.app')) {
    return {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      },
    };
  }

  // ntfy 风格（含自建实例）：裸文本正文 + Title/Priority header。
  if (url.hostname === 'ntfy.sh' || url.pathname.split('/').filter(Boolean).length === 1) {
    return {
      init: {
        method: 'POST',
        headers: { Title: title, Priority: ev.status === 'failed' ? 'high' : 'default' },
        body,
      },
    };
  }

  // Generic JSON webhook。
  return {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, title, body }),
    },
  };
}

/** 是否回环地址（localhost/127.0.0.1/[::1]）。 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * 回环地址直连 POST（node:http）。
 */
function postLoopback(url: URL, init: RequestInit): Promise<boolean> {
  return new Promise((resolvePromise) => {
    void (async () => {
      const mod = url.protocol === 'https:' ? await import('node:https') : await import('node:http');
      const headers: Record<string, string> = {};
      const headersInit = init.headers;
      if (headersInit) {
        for (const [k, v] of Object.entries(headersInit as Record<string, string>)) headers[k] = v;
      }
      const body = typeof init.body === 'string' ? init.body : '';
      headers['Content-Length'] = String(Buffer.byteLength(body));
      const req = mod.request(url, { method: init.method, headers, timeout: 10000 }, (res) => {
        res.resume();
        resolvePromise((res.statusCode ?? 500) < 400);
      });
      req.on('error', () => resolvePromise(false));
      req.on('timeout', () => {
        req.destroy();
        resolvePromise(false);
      });
      req.end(body);
    })();
  });
}

/** 发送通知。best-effort：成功返回 true，任何失败静默 false。 */
export async function sendNotification(webhookUrl: string | undefined, ev: NotifyEvent): Promise<boolean> {
  if (!webhookUrl) return false;
  const spec = buildNotifyRequest(webhookUrl, ev);
  if (!spec) return false;
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return false;
  }
  try {
    if (isLoopback(url.hostname)) return await postLoopback(url, spec.init);
    const res = await fetch(url, { ...spec.init, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}
