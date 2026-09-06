import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHostClient, resolveMocodeHostLaunchSpec } from '@mocode/runtime/host';

const workspace = mkdtempSync(path.join(os.tmpdir(), 'mocode-runtime-host-'));
const client = new AgentHostClient({ startupTimeoutMs: 20_000 });
let ready = false;
client.onEvent((envelope) => {
  if (envelope.type === 'event' && envelope.event === 'runtime_ready') ready = true;
});
client.onDiagnostic((message) => process.stderr.write(message));

try {
  const spec = resolveMocodeHostLaunchSpec();
  await client.start(spec, { cwd: workspace, env: { MOCODE_MCP_ENABLED: 'false' } });
  if (!ready) throw new Error('Host produced output but no runtime_ready event.');
  console.log(`Runtime host smoke passed via ${spec.hostPath}`);
} finally {
  await client.stop();
  rmSync(workspace, { recursive: true, force: true });
}
