import * as THREE from './vendor/three.module.js';
import { createPetCharacter } from './pet-characters.js';
import { PET_CHARACTERS, normalizePetCharacter } from '../pet-characters.js';
import { setUpPetStudio } from './pet-studio.js';
import { damp } from './pet-rig.js';
import { PetGesture, PetInteraction } from '../pet-interaction.js';
import { PetBubble } from '../pet-bubble.js';

const canvas = document.querySelector('#pet-canvas');
const message = document.querySelector('#message');
const detail = document.querySelector('#detail');
const bubble = document.querySelector('#bubble');
const progressLabel = document.querySelector('#progress-label');
const progressTrack = document.querySelector('#progress-track');
const progressFill = document.querySelector('#progress-fill');
const announcement = document.querySelector('#announcement');
const bubbleState = new PetBubble();
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
} catch (error) {
  bubble.hidden = false;
  message.textContent = '暂时无法显示 Mo';
  detail.textContent = '请在系统中开启图形加速后重试';
  throw error;
}
renderer.setSize(160, 135);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = setUpPetStudio(renderer, scene);
const character = normalizePetCharacter(await window.pet.character?.());
const characterName = PET_CHARACTERS.find((entry) => entry.id === character).name;
const mo = createPetCharacter(scene, character);
document.body.dataset.character = character;
document.title = `${characterName} · 桌面伙伴`;
canvas.setAttribute(
  'aria-label',
  `${characterName}。点身体抱抱，点头摸摸，拖动转圈并移动。空格摸头，上方向键跳跃，下方向键挥手，左方向键抱抱，右方向键转圈，回车查看任务。`,
);
const interaction = new PetInteraction();
const gesture = new PetGesture();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const look = { x: 0, y: 0 };
let task = { id: '', status: 'idle', title: '' };
let currentNotice = null;
let noticeUntil = 0;
let bubbleTaskId = '';
let polling = false;
let cursorPolling = false;
const hasTaskNotices = typeof window.pet.nextNotice === 'function';
const hasDesktopCursor = typeof window.pet.cursor === 'function';
let disposed = false;
let activePointer = null;
let dragSpinning = false;
let tappedHead = false;
let tappedModel = false;
let clickTimer;
let lastAction = '';
let lastUI = '';
let previousTime = 0;
let animationFrame;

const taskMessages = {
  idle: characterName + ' 在这里',
  running: '正在认真工作',
  waiting: '有件事需要你确认',
  completed: '完成啦，击个掌！',
  failed: '遇到问题啦，一起看看',
  cancelled: '休息一下，随时继续',
};
const actionMessages = {
  pat: ['嘿嘿，好舒服呀 ♡', '再摸摸头，充满电！'],
  hug: ['给你一个大大的抱抱 ♡', '辛苦啦，我陪着你呢'],
  wave: ['嗨，我在这里！', '今天也一起做点厉害的事'],
  jump: ['好耶！充满干劲！', '给努力的你一颗小星星'],
  spin: ['看我转个圈 ✧', '转一转，灵感就来啦'],
};
function showMessage(title, text, durationMs = 3500, withProgress = false, targetId = task.id) {
  bubbleTaskId = targetId;
  message.textContent = title;
  detail.textContent = text;
  bubble.title = targetId ? `查看任务：${text || task.title}` : '打开 MoCode Work';
  const total = task.plan?.total,
    done = task.plan?.done;
  const hasProgress = withProgress && Number.isFinite(total) && total > 0 && Number.isFinite(done);
  progressLabel.hidden = progressTrack.hidden = !hasProgress;
  if (hasProgress) {
    progressLabel.textContent = `${done}/${total}`;
    progressFill.style.width = `${Math.max(0, Math.min(100, (done / total) * 100))}%`;
  }
  bubbleState.show(performance.now(), durationMs);
  bubble.hidden = false;
  announcement.textContent = title;
}
function updateUI(reaction) {
  const action = reaction?.action ?? '';
  if (currentNotice && performance.now() >= noticeUntil) currentNotice = null;
  if (!action && bubbleState.observeTask(task) && !currentNotice) {
    if (!hasTaskNotices || !['waiting', 'completed', 'failed'].includes(task.status)) {
      showMessage(taskMessages[task.status] ?? taskMessages.idle, task.title || '', 5000, true);
    }
  }
  const status = currentNotice?.status ?? task.status;
  const visible = bubbleState.visible(performance.now());
  if (bubble.hidden === visible) bubble.hidden = !visible;
  const key = JSON.stringify([status, action]);
  if (key === lastUI) return;
  lastUI = key;
  document.body.dataset.status = status;
  document.body.dataset.action = action;
}
function announce(action) {
  if (!currentNotice) showMessage(...actionMessages[action]);
  updateUI(interaction.current(performance.now()));
}
function trigger(action) {
  interaction.trigger(action, performance.now());
  announce(action);
}
async function poll() {
  if (polling || disposed) return;
  polling = true;
  try {
    const snapshot = await window.pet.snapshot();
    if (!disposed && snapshot) task = snapshot;
    if (hasTaskNotices && !disposed && !currentNotice && !interaction.current(performance.now())) {
      const notice = await window.pet.nextNotice();
      if (!disposed && notice) {
        currentNotice = notice;
        noticeUntil = performance.now() + 6000;
        const titles = { waiting: '任务需要你确认', completed: '任务已完成！', failed: '任务执行失败' };
        showMessage(titles[notice.status], notice.title, 6000, false, notice.taskId);
      }
    }
  } catch {
    /* 短暂 IPC 不可用时保留上一次任务，不吞掉互动。 */
  } finally {
    polling = false;
  }
}
async function pollCursor() {
  if (!hasDesktopCursor || cursorPolling || disposed) return;
  cursorPolling = true;
  try {
    const position = await window.pet.cursor();
    if (!disposed && position) {
      look.x = position.x;
      look.y = position.y;
    }
  } catch {
    /* 关窗时可能仍有一个未返回的采样。 */
  } finally {
    cursorPolling = false;
  }
}
void poll();
void pollCursor();
const pollTimer = setInterval(poll, 700);
const cursorTimer = hasDesktopCursor ? setInterval(pollCursor, 50) : null;

function hitTest(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, (-(event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(mo.root, true).find(({ object }) => object.visible);
  let node = hit?.object;
  while (node) {
    if (node.userData.part) return { hit: true, head: node.userData.part === 'head' };
    if (node.userData.headAbove !== undefined)
      return { hit: true, head: node.worldToLocal(hit.point.clone()).y > node.userData.headAbove };
    node = node.parent;
  }
  return { hit: Boolean(hit), head: false };
}
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || activePointer !== null) return;
  clearTimeout(clickTimer);
  activePointer = event.pointerId;
  dragSpinning = false;
  const hit = hitTest(event);
  tappedHead = hit.head;
  tappedModel = hit.hit;
  gesture.begin(event.screenX, event.screenY);
  canvas.setPointerCapture(event.pointerId);
});
function moveWindow(delta) {
  if (!dragSpinning) {
    dragSpinning = true;
    interaction.startDrag(performance.now());
    announce('spin');
  }
  window.pet.move(delta.x, delta.y);
}
canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  if (!hasDesktopCursor) {
    look.x = THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    look.y = THREE.MathUtils.clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  }
  if (event.pointerId !== activePointer) return;
  const delta = gesture.move(event.screenX, event.screenY);
  if (delta) moveWindow(delta);
});
canvas.addEventListener('pointerup', (event) => {
  if (event.pointerId !== activePointer) return;
  const delta = gesture.move(event.screenX, event.screenY);
  if (delta) moveWindow(delta);
  const result = gesture.finish();
  if (dragSpinning) interaction.endDrag(performance.now());
  dragSpinning = false;
  activePointer = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (result === 'click' && tappedModel) {
    const head = tappedHead;
    // 给原生双击留出时间；单击的动作不会被拖动或任务轮询覆盖。
    clickTimer = setTimeout(() => {
      const action = interaction.tap(head, performance.now());
      announce(action);
    }, 220);
  }
});
function cancelGesture() {
  if (dragSpinning) interaction.endDrag(performance.now());
  dragSpinning = false;
  activePointer = null;
  gesture.cancel();
}
canvas.addEventListener('pointercancel', cancelGesture);
canvas.addEventListener('lostpointercapture', cancelGesture);
canvas.addEventListener('pointerleave', () => {
  if (!hasDesktopCursor) look.x = look.y = 0;
});
canvas.addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  window.pet.open(currentNotice?.taskId ?? task.id);
});
canvas.addEventListener('keydown', (event) => {
  const actions = { ' ': 'pat', ArrowUp: 'jump', ArrowDown: 'wave', ArrowLeft: 'hug', ArrowRight: 'spin' };
  if (actions[event.key]) {
    event.preventDefault();
    trigger(actions[event.key]);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    window.pet.open(currentNotice?.taskId ?? task.id);
  }
});
bubble.addEventListener('click', () => window.pet.open(bubbleTaskId));

function animate(ms) {
  if (disposed) return;
  animationFrame = requestAnimationFrame(animate);
  if (ms - previousTime < 1000 / 40) return;
  const dt = Math.min((ms - previousTime) / 1000, 0.1);
  previousTime = ms;
  const t = ms / 1000,
    reaction = interaction.current(ms),
    action = reaction?.action;
  const s = currentNotice?.status ?? task.status,
    time = reaction?.elapsed ?? t;
  const running = s === 'running' && !action;
  const happy = action === 'pat' || action === 'hug' || action === 'jump' || (!action && s === 'completed');
  let y = Math.sin(t * 2) * 0.025,
    roll = Math.sin(t * 1.4) * 0.025,
    yaw = (mo.restYaw ?? 0) + Math.sin(t * 0.6) * 0.08;
  // 约左右 32°、上下 14°，仍由下面的阻尼平滑跟随。
  let headZ = look.x * 0.12,
    headX = look.y * 0.25,
    headY = look.x * 0.55;
  let squash = 1;
  const hugging = action === 'hug';
  if (running) headX += 0.12;
  if (!action && s === 'waiting') {
    headZ = Math.sin(t * 2.4) * 0.1;
  }
  if (!action && s === 'failed') {
    headZ = -0.16;
    headX = 0.2;
  }
  if (action === 'pat') {
    headZ = Math.sin(time * 7) * 0.12;
    headX = -0.09;
    headY = 0;
    squash = 1 - Math.sin(time * 7) * 0.018;
  }
  if (hugging) {
    const close =
      THREE.MathUtils.smoothstep(time, 0.2, 0.65) * (1 - THREE.MathUtils.smoothstep(reaction.progress, 0.82, 1));
    headZ = Math.sin(time * 3) * 0.08;
    headX = -0.05;
    headY = 0;
    y += Math.sin(time * 4) * 0.025;
    squash = 1 - close * 0.025;
  }
  if (action === 'wave') {
    headZ = -0.1;
    y += Math.sin(time * 5) * 0.04;
  }
  if (action === 'jump' || (!action && s === 'completed')) {
    const bounce = Math.max(0, Math.sin(time * 7));
    y += bounce * 0.23;
    squash = 1 - (1 - bounce) * 0.07;
    roll = Math.sin(time * 7) * 0.055;
  }
  if (action === 'spin') {
    const progress = reaction.progress;
    // 整圈后朝向与初始相同，避免结束时反向转回去。
    yaw += Math.PI * 2 * THREE.MathUtils.smoothstep(progress, 0, 0.9);
    y += Math.abs(Math.sin(time * 5)) * 0.11;
    headZ = Math.sin(time * 5) * 0.08;
  }
  if (lastAction === 'spin' && action !== 'spin') {
    mo.root.rotation.y = Math.atan2(Math.sin(mo.root.rotation.y), Math.cos(mo.root.rotation.y));
  }
  lastAction = action;
  mo.root.position.y = damp(mo.root.position.y, y, dt);
  mo.root.rotation.z = damp(mo.root.rotation.z, roll, dt);
  // 转圈直接跟随连续曲线，其余动作平滑回正。
  mo.root.rotation.y = action === 'spin' ? yaw : damp(mo.root.rotation.y, yaw, dt);
  mo.root.scale.y = damp(mo.root.scale.y, squash, dt);
  mo.root.scale.x = 2 - mo.root.scale.y;
  mo.head.rotation.set(
    damp(mo.head.rotation.x, headX * mo.headTurn, dt),
    damp(mo.head.rotation.y, headY * mo.headTurn, dt),
    damp(mo.head.rotation.z, headZ * mo.headTurn, dt),
  );
  mo.pose(s, action, time, reaction?.progress ?? 0, dt);
  mo.ears.forEach((ear, i) => {
    ear.rotation.z = damp(
      ear.rotation.z,
      ear.userData.rest + Math.sin(t * 2.3 + i) * 0.025 + (action === 'pat' ? Math.sin(time * 8 + i) * 0.12 : 0),
      dt,
    );
  });
  mo.feet.forEach((foot, i) => {
    foot.rotation.x = damp(foot.rotation.x, action === 'spin' ? Math.sin(time * 10 + i * Math.PI) * 0.25 : 0, dt);
  });
  const blink = t % 4.7 > 4.5 ? Math.max(0.08, Math.abs(Math.cos((((t % 4.7) - 4.5) * Math.PI) / 0.2))) : 1;
  mo.expression(happy, !action && s === 'failed', blink, look.x, s);
  mo.effects(
    action === 'pat' || action === 'hug' || action === 'jump' || action === 'spin'
      ? action
      : !action && s === 'completed'
        ? 'jump'
        : null,
    time,
  );
  updateUI(reaction);
  renderer.render(scene, camera);
}
animationFrame = requestAnimationFrame(animate);
addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(pollTimer);
  if (cursorTimer) clearInterval(cursorTimer);
  clearTimeout(clickTimer);
  cancelAnimationFrame(animationFrame);
  const geometries = new Set(),
    materials = new Set();
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) {
      for (const material of [object.material].flat()) materials.add(material);
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => {
    m.map?.dispose();
    m.dispose();
  });
  scene.environment.dispose();
  renderer.dispose();
});
