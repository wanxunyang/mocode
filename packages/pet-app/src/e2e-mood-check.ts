// 任务 8:端到端逻辑验证(脚本化,不依赖真实 Electron/图形环境/真实 mocode CLI 进程)。
// 直接调用已完成的纯逻辑模块 mood.ts / mood-tracker.ts / quips.ts / skins.ts,
// 模拟 design.md 里描述的完整事件序列,断言 Mood 链路与皮肤个性化行为符合预期。
// 本脚本只读验证,不修改被验证的任何模块。
// 运行(在 f:\mocode 根目录):npx tsx packages/pet-app/src/e2e-mood-check.ts
//
// 说明:skins.ts 的 skinsDir() 按"该模块自身文件所在目录 + assets/pets"解析 manifest.json 路径
// (设计意图见 skins.ts 注释:生产环境下 dist/skins.js 与 dist/assets/ 同级)。用 tsx 直接运行本脚本时,
// 模块的 import.meta.url 指向 src/skins.ts,同级并无 assets/ 目录(真实素材放在 packages/pet-app/assets/,
// 由构建脚本 copy-static.mjs 复制到 dist/assets/)。为了不修改 skins.ts 就能让 listSkinEntries() 在此
// 场景下"真实读取"到 manifest.json,这里在调用前临时把 ../assets 镜像到 ./assets(与构建产物的目录关系
// 完全一致),验证结束后在 finally 里删除,不在仓库里留下任何新增/改动的痕迹。

import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempAssetsDir = path.join(__dirname, 'assets');
const realAssetsDir = path.join(__dirname, '..', 'assets');
const createdTempAssets = !existsSync(tempAssetsDir);
if (createdTempAssets) {
  cpSync(realAssetsDir, tempAssetsDir, { recursive: true });
}

const { createMoodTracker } = await import('./mood-tracker.js');
const { listSkinEntries } = await import('./skins.js');
const { UNIVERSAL_QUIPS, pickQuip } = await import('./quips.js');

let passed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  passed++;
  console.log('✓ ' + msg);
};

try {
  // ── 场景1:agent 长时间停留在 thinking(同理 tool_call)触发 tired ─────────
  // 每 5000ms 上报一次 thinking,ts: 0..60000。默认 tiredMs=60000。
  {
    const tracker = createMoodTracker();
    let reachedTired = false;
    for (let ts = 0; ts <= 60000; ts += 5000) {
      tracker.recordState('thinking', ts);
      const res = tracker.evaluate(ts);
      if (ts < 60000) {
        assert(
          res === null,
          `场景1: ts=${ts} (<60000) 时不应推送 tired(evaluate 应返回 null,实际 ${JSON.stringify(res)})`,
        );
      } else {
        assert(
          res !== null && res.mood === 'tired',
          `场景1: ts=60000(达到 tiredMs 阈值)时 mood 应变为 tired(实际 ${JSON.stringify(res)})`,
        );
        reachedTired = true;
      }
    }
    assert(reachedTired, '场景1: 已跑到 ts=60000 并验证 tired 触发');
  }

  // ── 场景2:10 秒内 5 次 tool_call 触发 flustered ─────────────────────────
  // 默认 toolWindowMs=10000, toolCount=5。
  {
    const tracker = createMoodTracker();
    for (const ts of [0, 2000, 4000, 6000, 8000]) {
      tracker.recordState('tool_call', ts);
    }
    const res = tracker.evaluate(8000);
    assert(
      res !== null && res.mood === 'flustered',
      `场景2: 10s 内 5 次 tool_call → mood 应为 flustered(实际 ${JSON.stringify(res)})`,
    );
  }

  // ── 场景3:60 秒内 2 次 error 触发 frustrated ────────────────────────────
  // 默认 errorWindowMs=60000, errorCount=2。
  {
    const tracker = createMoodTracker();
    tracker.recordState('error', 0);
    tracker.recordState('error', 30000);
    const res = tracker.evaluate(30000);
    assert(
      res !== null && res.mood === 'frustrated',
      `场景3: 60s 窗口内 2 次 error → mood 应为 frustrated(实际 ${JSON.stringify(res)})`,
    );
  }

  // ── 场景4:waiting_human 超时触发 urging ─────────────────────────────────
  // 默认 urgingMs=30000。
  {
    const tracker = createMoodTracker();
    tracker.recordState('waiting_human', 0);
    const res = tracker.evaluate(30000);
    assert(
      res !== null && res.mood === 'urging',
      `场景4: waiting_human 持续 30000ms → mood 应为 urging(实际 ${JSON.stringify(res)})`,
    );
  }

  // ── 场景5:idle 超时触发 bored ────────────────────────────────────────────
  // 默认 boredMs=300000。
  {
    const tracker = createMoodTracker();
    tracker.recordState('idle', 0);
    const res = tracker.evaluate(300000);
    assert(
      res !== null && res.mood === 'bored',
      `场景5: idle 持续 300000ms → mood 应为 bored(实际 ${JSON.stringify(res)})`,
    );
  }

  // ── 场景6:多条件同时满足,只呈现最高优先级 mood ──────────────────────────
  // 选用组合:frustrated(errorCount=2,errorWindowMs=60000) vs tired(tiredMs=60000)。
  // 关键设计:tired/bored/urging 只看"末尾同状态连续段"的起始时间(currentStateSince),
  // 而 frustrated/flustered 看的是"整个事件历史里落在滑动窗口内"的计数,两者不互斥。
  // 序列:error@0, error@0, thinking@0 —— 末尾状态是 thinking,起始时间就是它自己的 ts=0;
  // 同时前面两条 error 事件的 ts=0 仍落在以 now=60000、宽度 60000 的窗口 [0,60000] 内。
  // 于是在 now=60000 时:tired 条件成立(60000-0>=60000)且 frustrated 条件成立(窗口内 2 条 error)。
  // MOOD_PRIORITY = [frustrated, flustered, urging, tired, bored],frustrated 排在 tired 之前,
  // 因此应最终呈现 frustrated 而不是 tired。
  {
    const tracker = createMoodTracker();
    tracker.recordState('error', 0);
    tracker.recordState('error', 0);
    tracker.recordState('thinking', 0);
    const res = tracker.evaluate(60000);
    assert(
      res !== null && res.mood === 'frustrated',
      `场景6: frustrated(2次error@60000ms窗口内) 与 tired(thinking持续60000ms) 同时满足 → 应呈现优先级更高的 frustrated,不是 tired(实际 ${JSON.stringify(res)})`,
    );
  }

  // ── 场景7:断开活跃连接重新连接后,mood 判定不受上一个会话历史事件影响 ────
  {
    const tracker = createMoodTracker();
    tracker.recordState('thinking', 0);
    const tiredRes = tracker.evaluate(60000);
    assert(
      tiredRes !== null && tiredRes.mood === 'tired',
      `场景7: 会话A 先触发 tired 作为前置条件(实际 ${JSON.stringify(tiredRes)})`,
    );

    tracker.reset();
    // 用同一个 now=60000 再 evaluate 一次:若 events 未被真正清空,tired 条件依旧成立且
    // mood 与上次推送的 'tired' 相同 → evaluate 会因"未变化"返回 JS null(不会是 {mood:null})。
    // 只有 events 真被清空,deriveMood([], 60000) 才会算出 null,与上次推送的 'tired' 不同,
    // 从而触发一次"变化推送"返回 {mood:null}。用这个差异来验证 reset 确实清空了事件缓冲。
    const afterReset = tracker.evaluate(60000);
    assert(
      afterReset !== null && afterReset.mood === null,
      `场景7: reset() 后立即 evaluate 应返回 {mood:null}(证明 events 已清空,不是简单的"未变化"判定;实际 ${JSON.stringify(afterReset)})`,
    );

    // 新会话从零开始:只记一条 idle 事件,时间差远小于 boredMs(300000),不应触发任何 mood,
    // 也不应因为旧会话的 tired 历史残留而误判。
    tracker.recordState('idle', 60000);
    const newSessionRes = tracker.evaluate(61000);
    assert(
      newSessionRes === null,
      `场景7: 新会话记一条 idle、时间差(1000ms)远小于 boredMs → mood 应仍是 null(evaluate 返回 null,无残留旧 mood;实际 ${JSON.stringify(newSessionRes)})`,
    );
  }

  // ── 场景8:定制皮肤展示专属文案,未定制皮肤正确回退通用池 ──────────────────
  {
    const entries = listSkinEntries();
    const cat = entries.find((e) => e.id === 'robo-cat');
    assert(!!cat, '场景8: manifest.json 中应存在 robo-cat 条目');
    assert(
      !!cat?.quips && Array.isArray(cat.quips.tired) && Array.isArray(cat.quips.bored) && Array.isArray(cat.quips.urging),
      `场景8: robo-cat.quips 应包含 tired/bored/urging 数组字段(实际 ${JSON.stringify(cat?.quips)})`,
    );
    const catTired = cat!.quips!.tired!;
    for (let i = 0; i < 20; i++) {
      const q = pickQuip('tired', cat!.quips);
      assert(
        catTired.includes(q),
        `场景8: robo-cat 的 tired 文案应从专属池选取(第 ${i + 1} 次得到 "${q}",专属池 ${JSON.stringify(catTired)})`,
      );
    }

    const fox = entries.find((e) => e.id === 'robo-fox');
    assert(!!fox, '场景8: manifest.json 中应存在 robo-fox 条目');
    assert(
      fox?.quips === undefined,
      `场景8: robo-fox 未定制 quips,应解析为 undefined(实际 ${JSON.stringify(fox?.quips)})`,
    );
    for (let i = 0; i < 20; i++) {
      const q = pickQuip('tired', fox!.quips);
      assert(
        UNIVERSAL_QUIPS.tired.includes(q),
        `场景8: robo-fox 未定制皮肤应回退通用池(第 ${i + 1} 次得到 "${q}",通用池 ${JSON.stringify(UNIVERSAL_QUIPS.tired)})`,
      );
    }
  }

  console.log(`\nOK: ${passed} passed, 0 failed`);
} finally {
  if (createdTempAssets) {
    rmSync(tempAssetsDir, { recursive: true, force: true });
  }
}
