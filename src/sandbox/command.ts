// run_command 的 best-effort 命令层原语。**非安全边界**——只挡误操作与低水平 prompt 注入,
// 真隔离需 OS jailer(bwrap/firejail/sandbox-exec/docker,本次不做)。cwd 钉死由 run_command
// 自己用 getSandboxRoot() 做;本模块只提供 env 脱敏与灾难命令 denylist。

/** env 脱敏 denylist:删敏感键(*KEY / *TOKEN / *SECRET / *CREDENTIAL / *PASSWORD / LLM_*)。
 *  防 LLM_API_KEY / ANYSEARCH_API_KEY 泄给子进程。用 denylist——白名单会误杀 npm/git 需要的
 *  PATH/HOME/USERPROFILE 等 vars,不稳。 */
const ENV_DENY = /^(.*_?KEY|.*TOKEN|.*SECRET|.*CREDENTIAL|.*PASSWORD|LLM_.*)$/i;

/** 返回 env 浅拷贝,删敏感键。 */
export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_DENY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 灾难性文件操作 denylist:仅挡最明显的 fs 破坏(rm -rf /、rm -rf ~、rm -rf /*、fork bomb、
 * mkfs、dd of=/dev/、chmod -R 777 /)。**不挡 curl/wget/sudo**——用户目标是 fs 隔离,不是网络/提权;
 * curl 写到 cwd 不算逃逸。大小写无关、粗匹配。刻意者可绕($IFS / base64 / env var 拼接),
 * 故文档明确:非安全边界。返 string = 拒绝原因;null = 放行。
 */
const CMD_DENY: RegExp[] = [
  // rm -rf /  (flags 含 r 与 f,任序;目标 = 根、根*、家目录)
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$|\*)/i,
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(\s|$|\*)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+~(\s|$)/i,
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+~(\s|$)/i,
  /:\s*\(\)\s*\{/i, // :(){ fork bomb
  /\bmkfs\b/i,
  /\bdd\b.*of=\/dev\//i,
  /\bchmod\s+-R\s+777\s+\/(\s|$)/i,
];

export function isCommandDenied(cmd: string): string | null {
  for (const re of CMD_DENY) {
    if (re.test(cmd)) return `命令被沙箱拒绝(灾难性文件操作): ${cmd}`;
  }
  return null;
}
