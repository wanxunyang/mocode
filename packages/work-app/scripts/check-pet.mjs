import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PET_CHARACTERS } from '../dist/pet-characters.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = path.join(root, 'dist');
const character = 'byte';
const output = path.join(root, 'build', 'pet-preview', character);
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(base, '.' + decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    'Content-Type',
    file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
  );
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const executablePath =
    process.env.CHROME_PATH ||
    [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((file) => fs.existsSync(file));
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 240, height: 230 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ character }) => {
      window.testTask = { id: 'demo', status: 'idle', title: '' };
      window.testMoves = [];
      window.testOpens = [];
      window.pet = {
        character: async () => new URL(location.href).searchParams.get('character') || character,
        snapshot: async () => window.testTask,
        move: (x, y) => window.testMoves.push([x, y]),
        open: (id) => window.testOpens.push(id),
      };
    },
    { character },
  );
  const url = `http://127.0.0.1:${server.address().port}/renderer/pet.html`;
  const cards = [];
  for (const { id, name } of PET_CHARACTERS) {
    const directory = path.join(root, 'build', 'pet-preview', id);
    fs.mkdirSync(directory, { recursive: true });
    await page.goto(url + '?character=' + id);
    await page.waitForFunction(
      (id) => document.body.dataset.character === id && document.body.dataset.status === 'idle',
      id,
    );
    const shape = await page.evaluate(async (id) => {
      const THREE = await import('/renderer/vendor/three.module.js');
      const { createPetCharacter } = await import('/renderer/pet-characters.js');
      const pet = createPetCharacter(new THREE.Scene(), id);
      const monitor = pet.root.getObjectByName('pet-square-monitor');
      return {
        hands: pet.root.getObjectsByProperty('name', 'pet-mitten').length,
        laptop: Boolean(pet.root.getObjectByName('pet-laptop')),
        square: monitor ? monitor.scale.x === monitor.scale.y : false,
      };
    }, id);
    assert.deepEqual(shape, { hands: 2, laptop: id === 'byte', square: id === 'byte' });
    const canvas = page.locator('#pet-canvas');
    await page.waitForTimeout(220);
    const idle = await canvas.screenshot({ path: path.join(directory, 'portrait.png'), omitBackground: true });
    await canvas.press('ArrowDown');
    await page.waitForFunction(() => document.body.dataset.action === 'wave');
    await canvas.evaluate((element) => element.blur());
    await page.waitForTimeout(380);
    const wave = await canvas.screenshot({ path: path.join(directory, 'wave.png'), omitBackground: true });
    await page.mouse.click(120, 145.5);
    await page.waitForFunction(() => document.body.dataset.action === 'pat');
    await page.mouse.click(120, 183);
    await page.waitForFunction(() => document.body.dataset.action === 'hug');
    await canvas.press('ArrowRight');
    await page.waitForFunction(() => document.body.dataset.action === 'spin');
    await canvas.evaluate((element) => element.blur());
    await page.waitForTimeout(1200);
    await canvas.screenshot({ path: path.join(directory, 'turn.png'), omitBackground: true });
    const uri = (buffer) => 'data:image/png;base64,' + buffer.toString('base64');
    cards.push({ name, idle: uri(idle), wave: uri(wave) });
  }
  const gallery = await browser.newPage({ viewport: { width: 1000, height: 390 }, deviceScaleFactor: 1.5 });
  await gallery.setContent(`<meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f6f3ec;color:#443e32;font:16px "Microsoft YaHei",sans-serif}
    main{display:grid;grid-template-columns:repeat(5,1fr);height:100vh;padding:16px 20px;gap:8px}
    figure{margin:0;text-align:center;align-self:center}img{display:block;width:100%;height:auto}
    figcaption{padding:10px 0;font-weight:600}
    </style><main>${cards.map(({ name, idle, wave }) => `<figure><img src="${idle}"><figcaption>${name}</figcaption><img src="${wave}"></figure>`).join('')}</main>`);
  await gallery.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
  await gallery.screenshot({ path: path.join(root, 'build', 'pet-preview', 'companions.png') });
  await gallery.close();
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.status === 'idle');
  assert.equal(await page.locator('#bubble').isHidden(), true);
  assert.equal(await page.locator('#hint').count(), 0);
  const layout = await page.evaluate(() => ({
    font: getComputedStyle(document.querySelector('#message')).fontSize,
    detail: getComputedStyle(document.querySelector('#detail')).fontSize,
    width: document.querySelector('canvas').getBoundingClientRect().width,
    height: document.querySelector('canvas').getBoundingClientRect().height,
  }));
  assert.deepEqual(layout, { font: '14px', detail: '12px', width: 160, height: 135 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(output, 'idle.png'), omitBackground: true });
  await page.evaluate(() => (document.body.style.background = '#18161e'));
  await page.screenshot({ path: path.join(output, 'idle-dark.png') });
  await page.locator('#pet-canvas').screenshot({ path: path.join(output, 'character.png') });
  await page.evaluate(() => (document.body.style.background = 'transparent'));
  assert.equal(await page.locator('#actions').count(), 0);
  // Head and body are tested through the actual 3D hit areas, without action buttons.
  await page.mouse.click(120, 145.5);
  await page.waitForFunction(() => document.body.dataset.action === 'pat');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(output, 'pat.png'), omitBackground: true });
  assert.equal(await page.evaluate(() => window.testMoves.length), 0);
  await page.waitForFunction(() => document.body.dataset.action === '');
  await page.mouse.click(120, 183);
  await page.waitForFunction(() => document.body.dataset.action === 'hug');
  assert.equal(await page.locator('#bubble').isVisible(), true);
  await page.waitForTimeout(750);
  await page.screenshot({ path: path.join(output, 'hug.png'), omitBackground: true });
  await page.waitForFunction(() => document.body.dataset.action === '');
  await page.waitForFunction(() => document.querySelector('#bubble').hidden);
  assert.equal(await page.locator('#bubble').isHidden(), true);
  // Small hand tremors remain a body click, not a drag.
  await page.mouse.move(120, 183);
  await page.mouse.down();
  await page.mouse.move(122, 184);
  await page.mouse.up();
  await page.waitForFunction(() => document.body.dataset.action === 'hug');
  assert.equal(await page.evaluate(() => window.testMoves.length), 0);
  await page.waitForFunction(() => document.body.dataset.action === '');
  await page.mouse.move(120, 173);
  await page.mouse.down();
  await page.mouse.move(136, 178, { steps: 5 });
  await page.waitForFunction(() => document.body.dataset.action === 'spin');
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(output, 'spin.png'), omitBackground: true });
  // Holding longer than one complete animation must not stop the drag reaction.
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => document.body.dataset.action), 'spin');
  assert.ok((await page.evaluate(() => window.testMoves.length)) > 0);
  await page.mouse.up();
  await page.waitForFunction(() => document.body.dataset.action === '');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.body.dataset.action), '');
  await page.evaluate(
    () => (window.testTask = { id: 'run', status: 'running', title: '构建 MoCode Work', plan: { done: 2, total: 5 } }),
  );
  await page.waitForFunction(() => document.body.dataset.status === 'running');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, 'working.png'), omitBackground: true });
  assert.equal(await page.locator('#progress-label').textContent(), '2/5');
  // The same snapshot keeps polling, but must not keep a notice on screen.
  await page.waitForFunction(() => document.querySelector('#bubble').hidden);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#bubble').isHidden(), true);
  await page.evaluate(() => (window.testTask.plan.done = 3));
  await page.waitForFunction(() => !document.querySelector('#bubble').hidden);
  assert.equal(await page.locator('#progress-label').textContent(), '3/5');
  await page.mouse.click(120, 145.5);
  await page.waitForFunction(() => document.body.dataset.action === 'pat');
  await page.waitForTimeout(850);
  assert.equal(await page.evaluate(() => document.body.dataset.action), 'pat');
  assert.equal(await page.locator('#progress-label').isHidden(), true);
  await page.waitForFunction(() => document.body.dataset.action === '');
  assert.equal(await page.evaluate(() => document.body.dataset.status), 'running');
  await page.locator('#bubble').click();
  assert.equal(await page.evaluate(() => window.testOpens.at(-1)), 'run');
  await page.mouse.dblclick(120, 145.5);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.body.dataset.action), '');
  assert.equal(await page.evaluate(() => window.testOpens.at(-1)), 'run');
  await page.evaluate(() => (window.testTask = { id: 'wait', status: 'waiting', title: '需要批准执行命令' }));
  await page.waitForFunction(() => document.body.dataset.status === 'waiting');
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(output, 'waiting.png'), omitBackground: true });
  await page.evaluate(() => (window.testTask = { id: 'fail', status: 'failed', title: '检查失败，请查看输出' }));
  await page.waitForFunction(() => document.body.dataset.status === 'failed');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, 'failed.png'), omitBackground: true });
  await page.locator('#pet-canvas').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.body.dataset.action === 'pat');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.body.dataset.action === 'hug');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.body.dataset.action === 'jump');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, 'jump.png'), omitBackground: true });
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.testOpens.at(-1)), 'fail');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: idle bubble hidden; readable text; same-size character; no footer; notices expire despite polling; plan updates reopen bubble; no action buttons; head tap pats; body tap hugs; drag spins and moves; long drag keeps spinning; small tremors still tap; task progress; reaction restores task; keyboard and task navigation.',
  );
  console.log('Previews: ' + output);
} finally {
  await browser?.close();
  server.close();
}
