import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PET_CHARACTERS } from '../dist/pet-characters.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'build', 'pet-preview');
mkdirSync(output, { recursive: true });
const entry = path.join(output, 'notices-main.cjs');
const moduleURL = new URL('../dist/desktop-pet.js', import.meta.url).href;
writeFileSync(
  entry,
  `const {app}=require('electron');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const {DesktopPet}=await import(${JSON.stringify(moduleURL)});
 global.pet=new DesktopPet();
 global.pet.update([{id:'initial',title:'Initial task',status:'running',updatedAt:''}]);
 global.pet.setEnabled(true);
});`,
);
const app = await electron.launch({ args: [entry], timeout: 15000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => document.body.dataset.status === 'running');
  assert.equal(await page.evaluate(() => document.body.dataset.character), 'byte');
  for (const { id } of PET_CHARACTERS) {
    await app.evaluate((_, id) => global.pet.setCharacter(id), id);
    await page.waitForFunction(
      (id) => document.body?.dataset.character === id && document.body.dataset.status === 'running',
      id,
    );
    assert.equal(await page.evaluate(() => window.pet.character()), id);
  }

  const cursor = await page.evaluate(() => window.pet.cursor());
  assert.ok(Number.isFinite(cursor.x) && Number.isFinite(cursor.y));
  assert.ok(Math.hypot(cursor.x, cursor.y) <= 1.000001);
  await app.evaluate(({ BrowserWindow }) => {
    global.opened = [];
    const main = new BrowserWindow({ show: false });
    main.show = () => {};
    main.focus = () => {};
    main.webContents.send = (channel, payload) => {
      if (channel === 'work:agent-event') global.opened.push(payload.requestId);
    };
    global.pet.update([
      { id: 'a', title: '任务 A', status: 'running', updatedAt: '' },
      { id: 'b', title: '任务 B', status: 'running', updatedAt: '' },
    ]);
    global.pet.update([
      { id: 'a', title: '任务 A', status: 'completed', updatedAt: '' },
      { id: 'b', title: '任务 B', status: 'waiting', updatedAt: '' },
    ]);
  });
  await page.waitForFunction(() => document.querySelector('#message').textContent === '任务需要你确认');
  assert.equal(await page.locator('#detail').textContent(), '任务 B');
  await page.screenshot({ path: path.join(output, 'notice-waiting.png'), omitBackground: true });
  await page.locator('#bubble').click();
  assert.equal(await app.evaluate(() => global.opened.at(-1)), 'b');
  await page.waitForFunction(() => document.querySelector('#message').textContent === '任务已完成！');
  assert.equal(await page.locator('#detail').textContent(), '任务 A');
  assert.equal(await page.evaluate(async () => (await window.pet.snapshot()).id), 'b');
  await page.screenshot({ path: path.join(output, 'notice-completed.png'), omitBackground: true });
  await page.locator('#bubble').click();
  assert.equal(await app.evaluate(() => global.opened.at(-1)), 'a');
  await page.waitForFunction(() => document.querySelector('#bubble').hidden);
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#bubble').isHidden(), true);
  assert.deepEqual(errors, []);
  await app.evaluate(() => global.pet.setCharacter('mo'));
  await page.waitForFunction(() => document.body?.dataset.character === 'byte');
  assert.equal(await page.evaluate(() => window.pet.character()), 'byte');
  await app.evaluate(() => global.pet.setEnabled(false));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  console.log(
    'PASS: all five characters switch in Electron; unknown settings fall back to Byte; desktop cursor IPC; human wait precedes background completion; correct task links; notices expire without repeats; closing pet cleans up.',
  );
} finally {
  await app.close();
}
