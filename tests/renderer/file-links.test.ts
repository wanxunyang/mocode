/**
 * 正文路径链接化：哪些文本算路径、算成哪种链接（预览还是去文件夹拿）。
 *
 * 回归背景：agent 跑完构建后在回复里写
 * 「安装包：packages/work-app/release/MoCode Work-1.1.0-setup.exe（148MB）」，
 * 用户点不动、只能自己从项目根逐级点进 release/ 把文件找出来。两个原因各自独立，
 * 都必须钉住：①`.exe` 这类产物扩展名不在白名单；②产物名中间有空格，
 * 而原有候选正则只允许 `[A-Za-z0-9_.-]` 组成的段。
 *
 * 这份模块除 `linkifyFilePaths` 外都是纯函数（无 DOM），所以解析部分在 node 里直接断言；
 * DOM 部分只在测试里用极简假 document 跑一遍结构，不引入 jsdom。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findFilePaths, isArtifactPath, kindOfPath } from '../../packages/work-app/src/renderer/file-links.js';

const paths = (text: string): string[] => findFilePaths(text).map((hit) => hit.path);

test('带空格与版本号的安装包能被整条识别（这是「点了取不到」的主因）', () => {
  const text = '安装包：packages/work-app/release/MoCode Work-1.1.0-setup.exe （148MB）';
  assert.deepEqual(paths(text), ['packages/work-app/release/MoCode Work-1.1.0-setup.exe']);
});

test('产物名里的空格不会把后面的普通路径一起吞进来', () => {
  const text = '产物 release/MoCode Work.exe 与源码 src/index.ts 都变了';
  assert.deepEqual(paths(text), ['release/MoCode Work.exe', 'src/index.ts']);
});

test('普通路径的空格放宽不外溢：两个路径之间隔着汉语时不会连成一条', () => {
  assert.deepEqual(paths('先改 src/a.ts 然后 docs/b.md 也要动'), ['src/a.ts', 'docs/b.md']);
  assert.deepEqual(paths('见 docs/a.md 或 b.txt'), ['docs/a.md']);
});

test('产物扩展名归到 artifact（点击 → 文件管理器定位），文本/代码归到 file（点击 → 面板预览）', () => {
  assert.equal(kindOfPath('release/MoCode Work-1.1.0-setup.exe'), 'artifact');
  assert.equal(kindOfPath('dist/app.zip'), 'artifact');
  assert.equal(kindOfPath('out/v1.2.0.dmg'), 'artifact');
  assert.equal(kindOfPath('src/index.ts'), 'file');
  assert.equal(kindOfPath('docs/plan.md'), 'file');
  // 不认识的后缀不链接化 —— 宁可点不动，也不要让正文里每个带点号的东西都变蓝。
  assert.equal(kindOfPath('src/a.unknownext'), null);
});

test('isArtifactPath 与 kindOfPath 同源（工具行文案据此选「去文件夹拿」还是「预览」）', () => {
  assert.equal(isArtifactPath('release/setup.exe'), true);
  assert.equal(isArtifactPath('src/main.ts'), false);
  assert.equal(isArtifactPath('随便一句没有路径的话'), false);
});

test('URL 与相对跳转不当路径', () => {
  assert.deepEqual(paths('详见 https://example.com/a/b.md'), []);
  assert.deepEqual(paths('版本 ./dist/x.zip 已生成'), ['./dist/x.zip']);
});

test('同一条路径不会被两条候选形态重复命中', () => {
  // 无空格产物两条正则都能匹配，去重后只应保留一条，否则 DOM 里会叠两个 <a>。
  const hits = findFilePaths('产物 dist/app.zip 已生成');
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ['dist/app.zip'],
  );
  assert.equal(hits.length, 1);
});

test('结果按出现顺序排列，且区间互不重叠', () => {
  const hits = findFilePaths('先 docs/a.md，再 src/b.ts，最后 out/c.zip');
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ['docs/a.md', 'src/b.ts', 'out/c.zip'],
  );
  for (let index = 1; index < hits.length; index += 1) {
    const previous = hits[index - 1]!;
    assert.ok(hits[index]!.index >= previous.index + previous.path.length);
  }
});
