/**
 * INVALID_JSON 诊断分级:
 * - 不再裸 catch,输出带长度/首尾片段/具体死因与可执行恢复建议。
 * - finish_reason=length(截断)时给 write_file append 分段 / edit_file 缩短 的专用指引。
 * - 长参数只回显首尾,不整段刷屏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeToolOutcome } from '../src/tools/registry.js';
import '../src/tools/builtins/index.js';

test('INVALID_JSON: 残缺 JSON 识别为结构残缺并给分段恢复路径', async () => {
  const raw = '{"path":"x","content":"abc';
  const out = await executeToolOutcome('write_file', raw);
  assert.equal(out.status, 'error');
  assert.equal(out.code, 'INVALID_JSON');
  assert.match(out.output, /不是合法 JSON/);
  assert.match(out.output, new RegExp(`收到 ${raw.length} 字符`));
  // "Unexpected end of JSON input" → 结构残缺,给截断恢复路径(append 分段)。
  assert.match(out.output, /append=true/);
});

test('INVALID_JSON: finishReason=length 明确指引 write_file 分段续写', async () => {
  const out = await executeToolOutcome('write_file', '{"path":"x","content":"abc', undefined, {
    finishReason: 'length',
  });
  assert.equal(out.code, 'INVALID_JSON');
  assert.match(out.output, /max_tokens/);
  assert.match(out.output, /append=true/);
  assert.match(out.output, /edit_file/);
  // 明确告知不要用相同参数重试。
  assert.match(out.output, /不要用相同参数重试/);
});

test('INVALID_JSON: edit_file 截断时建议缩短 old_string', async () => {
  const out = await executeToolOutcome('edit_file', '{"path":"x","old_string":"abc', undefined, {
    finishReason: 'length',
  });
  assert.equal(out.code, 'INVALID_JSON');
  assert.match(out.output, /缩短 old_string/);
});

test('INVALID_JSON: 字符串值裸换行判为转义错误', async () => {
  // JS 源码里的 \n 在单引号字符串中是真实换行符 → 进 JSON 字符串值后是非法裸控制字符。
  const raw = '{"path":"x","content":"a\nb"}';
  const out = await executeToolOutcome('write_file', raw);
  assert.equal(out.code, 'INVALID_JSON');
  assert.match(out.output, /裸控制字符|未正常结束|非法字符/);
  assert.match(out.output, /转义/);
});

test('INVALID_JSON: 长参数只回显首尾并标注省略长度', async () => {
  // 折叠阈值:长度 > 150*2+40=340。构造一个合法长 JSON 后从末尾截断(模拟 token 上限砍断)。
  const middle = 'M'.repeat(400);
  const valid = JSON.stringify({ path: 'x', content: `HEAD${middle}TAIL` });
  const truncated = valid.slice(0, valid.length - 5);
  const out = await executeToolOutcome('write_file', truncated, undefined, { finishReason: 'length' });
  assert.equal(out.code, 'INVALID_JSON');
  assert.match(out.output, /中间省略 \d+ 字符/);
  // 长串中部不应原样出现在回显里(只保留首尾各 150 字符窗口)。
  assert.ok(!out.output.includes(middle));
  assert.ok(out.output.includes('HEAD'));
});
