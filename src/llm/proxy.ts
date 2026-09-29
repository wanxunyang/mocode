/**
 * 进程级 HTTP(S) 代理安装。
 *
 * Node 的全局 fetch（undici）默认不读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（Node 24 需
 * --use-env-proxy 或 NODE_USE_ENV_PROXY=1）。这里在首个 client state 构建时显式安装
 * undici 的 EnvHttpProxyAgent：Clash/V2Ray 等本地代理通过环境变量或 Windows 系统代理
 * （WinINET 注册表）均可识别；本地 localhost/127.0.0.1 始终绕过。
 *
 * 幂等：进程内只安装一次。MOCODE_NO_ENV_PROXY=1 可完全关闭。
 */
import { execSync } from 'node:child_process';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let installed = false;

function withProtocol(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

export function parseWindowsProxyServer(raw: string): { http?: string; https?: string } {
  const entries = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const result: { http?: string; https?: string } = {};

  for (const entry of entries) {
    const match = /^(https?|socks)=(.+)$/i.exec(entry);
    if (!match) continue;
    const scheme = match[1].toLowerCase();
    const value = withProtocol(match[2].trim());
    if (scheme === 'https') result.https = value;
    else if (scheme === 'http') result.http = value;
  }

  // Clash Verge 常见形态：ProxyServer=127.0.0.1:7897（mixed port）。
  if (!result.http && !result.https && entries[0]?.includes(':')) {
    return { http: withProtocol(entries[0]), https: withProtocol(entries[0]) };
  }
  if (result.http && !result.https) result.https = result.http;
  return result;
}

function registryValue(name: string): string {
  try {
    const output = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = output.split(/\r?\n/).find((item) => item.includes(name));
    return (
      line
        ?.trim()
        .split(/\s{2,}/)
        .pop()
        ?.trim() ?? ''
    );
  } catch {
    return '';
  }
}

interface WindowsProxyOptions {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
}

function windowsProxyOptions(): WindowsProxyOptions | null {
  if (process.platform !== 'win32') return null;
  if (!/1$/.test(registryValue('ProxyEnable'))) return null;

  const parsed = parseWindowsProxyServer(registryValue('ProxyServer'));
  if (!parsed.http && !parsed.https) return null;

  const overrides = registryValue('ProxyOverride')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '<local>');
  const noProxy = [...new Set([...overrides, 'localhost', '127.0.0.1'])].join(',');

  return {
    ...(parsed.http ? { httpProxy: parsed.http } : {}),
    httpsProxy: parsed.https ?? parsed.http,
    noProxy,
  };
}

export function installEnvProxy(): void {
  if (installed) return;
  installed = true;
  if (process.env.MOCODE_NO_ENV_PROXY === '1') return;

  const envProxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const windowsOptions = windowsProxyOptions();
  const options = envProxy ? undefined : (windowsOptions ?? undefined);
  if (!envProxy && !windowsOptions) return;

  // EnvHttpProxyAgent 构造时会通过 process.emitWarning 打一条 UNDICI-EHPA 实验性警告，
  // 在 TUI 里可能落成脏行；屏蔽这一条特定警告，其余警告照常。
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('EnvHttpProxyAgent is experimental')) return;
    return (originalEmitWarning as (...a: unknown[]) => void)(...args);
  }) as typeof process.emitWarning;
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent(options));
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
