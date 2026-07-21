#!/usr/bin/env node
// Mocode Work 的本地 Agent Host。stdout 仅输出 NDJSON 协议事件；诊断写 stderr。
await import('../dist/host/stdio.js');
