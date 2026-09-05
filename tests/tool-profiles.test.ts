/**
 * 统一工具模式(profile)单测(docs/tool-profiles-design.md):
 * - profiles.ts 纯函数:5 个预置模式的工具簇组成、getProfileToolNames、isProfileName;
 * - config 派生开关:isMemoryEnabled/isComputerUseEnabled/isFrontendToolsEnabled/isSubAgentEnabled
 *   随 setActiveProfile 变化;旧 env 显式设置时覆盖模式推导;
 * - constants:getProfileDisabledTools / getRuntimeDisabledTools / getPlanDisabledTools;
 * - llm refreshChatTools:切模式后 chatTools / planChatTools 名单正确。
 *
 * 派生查询运行时读 process.env,测试里显式清理/恢复相关 env 保证确定性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_NAMES,
  TOOL_GROUPS,
  getProfileToolNames,
  profileHasGroup,
  isProfileName,
} from '../src/config/profiles.js';
import {
  getActiveProfile,
  setActiveProfile,
  isMemoryEnabled,
  isComputerUseEnabled,
  isFrontendToolsEnabled,
  isSubAgentEnabled,
} from '../src/config/index.js';
import {
  getProfileDisabledTools,
  getPlanDisabledTools,
  getRuntimeDisabledTools,
} from '../src/tools/constants.js';
import '../src/tools/builtins/index.js';
import { refreshChatTools, chatTools, planChatTools } from '../src/llm/index.js';

const OVERRIDE_ENVS = ['MEMORY_ENABLED', 'MOCODE_FRONTEND_TOOLS_ENABLED', 'MOCODE_COMPUTER_USE_ENABLED', 'MOCODE_SUBAGENT_ENABLED'];

/** 清掉四个旧开关 env(派生查询运行时读),返回恢复函数。 */
function clearOverrideEnvs(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of OVERRIDE_ENVS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const ALL_KNOWN_TOOLS = new Set(Object.values(TOOL_GROUPS).flat());

test('profiles: 预置 5 模式,coding 为省 token 默认(无 web/frontend/computer/memory/subagent)', () => {
  assert.deepEqual(PROFILE_NAMES, ['coding', 'frontend', 'computer-use', 'research', 'full']);
  const coding = getProfileToolNames('coding');
  // 核心读写 + agent-meta 全在
  assert.ok(coding.has('read_file') && coding.has('write_file') && coding.has('run_command') && coding.has('edit_file'));
  assert.ok(coding.has('plan_update') && coding.has('ask_human'));
  // view_image 必须在 core-read(截图/computer 回灌靠它看)
  assert.ok(coding.has('view_image'));
  // 省 token:不装浏览器/桌面/记忆/联网/子代理
  for (const t of ['browser', 'dev_server', 'screenshot', 'computer', 'memory_search', 'web_search', 'sub-agent']) {
    assert.ok(!coding.has(t), `coding should not include ${t}`);
  }
});

test('profiles: full 模式 = 全部已知工具;research 只读(无写盘/命令)', () => {
  const full = getProfileToolNames('full');
  for (const t of ALL_KNOWN_TOOLS) assert.ok(full.has(t), `full should include ${t}`);
  const research = getProfileToolNames('research');
  for (const t of ['write_file', 'edit_file', 'run_command']) assert.ok(!research.has(t));
  assert.ok(research.has('web_search') && research.has('memory_save') && research.has('read_file'));
});

test('profiles: isProfileName 校验;profileHasGroup 派生簇归属', () => {
  assert.ok(isProfileName('coding') && isProfileName('full'));
  assert.ok(!isProfileName('nope') && !isProfileName(42));
  assert.ok(profileHasGroup('computer-use', 'computer'));
  assert.ok(!profileHasGroup('computer-use', 'memory'));
  assert.ok(profileHasGroup('frontend', 'frontend') && profileHasGroup('frontend', 'web'));
});

test('config 派生开关:随 setActiveProfile 切换', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    assert.equal(isMemoryEnabled(), false);
    assert.equal(isComputerUseEnabled(), false);
    assert.equal(isFrontendToolsEnabled(), false);
    assert.equal(isSubAgentEnabled(), false);
    setActiveProfile('computer-use');
    assert.equal(isComputerUseEnabled(), true);
    assert.equal(isMemoryEnabled(), false);
    setActiveProfile('research');
    assert.equal(isMemoryEnabled(), true);
    assert.equal(isComputerUseEnabled(), false);
    setActiveProfile('full');
    assert.ok(isMemoryEnabled() && isComputerUseEnabled() && isFrontendToolsEnabled() && isSubAgentEnabled());
    setActiveProfile(prev);
  } finally {
    restore();
  }
});

test('config 派生开关:旧 env 显式设置时覆盖模式推导', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    process.env.MEMORY_ENABLED = 'true';
    assert.equal(isMemoryEnabled(), true); // env 覆盖 coding 模式
    process.env.MOCODE_COMPUTER_USE_ENABLED = 'false';
    setActiveProfile('computer-use');
    assert.equal(isComputerUseEnabled(), false); // env=false 盖掉模式含簇
    delete process.env.MOCODE_COMPUTER_USE_ENABLED;
    assert.equal(isComputerUseEnabled(), true); // 删 env 后回落模式推导
    setActiveProfile(prev);
  } finally {
    restore();
  }
});

test('getProfileDisabledTools: coding 屏蔽非核心簇;full 不屏蔽任何已知工具', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    const disabled = getProfileDisabledTools();
    for (const t of ['browser', 'dev_server', 'screenshot', 'computer', 'memory_save', 'web_search', 'web_fetch', 'sub-agent']) {
      assert.ok(disabled.has(t), `coding should disable ${t}`);
    }
    assert.ok(!disabled.has('read_file') && !disabled.has('write_file'));
    setActiveProfile('full');
    const fullDisabled = getProfileDisabledTools();
    for (const t of ALL_KNOWN_TOOLS) assert.ok(!fullDisabled.has(t), `full should not disable ${t}`);
    setActiveProfile(prev);
  } finally {
    restore();
  }
});

test('getProfileDisabledTools 与派生开关 reconcile:env 覆盖一致', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    process.env.MEMORY_ENABLED = 'true';
    const disabled = getProfileDisabledTools();
    assert.ok(!disabled.has('memory_save'), 'env MEMORY_ENABLED=true should un-disable memory tools');
    setActiveProfile(prev);
  } finally {
    restore();
  }
});

test('getRuntimeDisabledTools: 并入 profile 屏蔽集;getPlanDisabledTools 按 memory 开关增减', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    const rt = getRuntimeDisabledTools();
    assert.ok(rt.has('computer') && rt.has('browser') && rt.has('memory_save') && rt.has('sub-agent'));
    assert.ok(!rt.has('write_file'), 'coding 模式 auto 下 write_file 不该被运行时屏蔽');
    // plan:memory off 时写工具名不在屏蔽集(死名字清理)
    const planOff = getPlanDisabledTools();
    assert.ok(!planOff.has('memory_save') && !planOff.has('memory_update'));
    assert.ok(planOff.has('write_file') && planOff.has('computer'));
    setActiveProfile('research'); // memory on
    const planOn = getPlanDisabledTools();
    assert.ok(planOn.has('memory_save') && planOn.has('memory_update'));
    setActiveProfile(prev);
  } finally {
    restore();
  }
});

test('refreshChatTools: 按当前 profile 过滤模型可见工具;plan 再叠 plan 屏蔽集', () => {
  const restore = clearOverrideEnvs();
  try {
    const prev = getActiveProfile();
    setActiveProfile('coding');
    refreshChatTools();
    const names = chatTools.map((t) => t.function.name);
    assert.ok(names.includes('read_file') && names.includes('write_file') && names.includes('view_image'));
    for (const t of ['browser', 'computer', 'memory_search', 'web_search', 'sub-agent']) {
      assert.ok(!names.includes(t), `coding chatTools should not include ${t}`);
    }
    setActiveProfile('full');
    refreshChatTools();
    const fullNames = chatTools.map((t) => t.function.name);
    for (const t of ['browser', 'computer', 'memory_search', 'web_search', 'sub-agent']) {
      assert.ok(fullNames.includes(t), `full chatTools should include ${t}`);
    }
    // plan 模式:full 下仍剔除写盘/命令/computer/sub-agent
    const planNames = planChatTools.map((t) => t.function.name);
    for (const t of ['write_file', 'edit_file', 'run_command', 'computer', 'sub-agent', 'memory_save']) {
      assert.ok(!planNames.includes(t), `planChatTools should not include ${t}`);
    }
    assert.ok(planNames.includes('read_file') && planNames.includes('web_search'));
    setActiveProfile(prev);
    refreshChatTools();
  } finally {
    restore();
  }
});
