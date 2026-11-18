import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solvePetArm,
  petArmTargets,
  ARM_UPPER,
  ARM_LOWER,
  petArmSkin,
  type ArmPoint,
} from '../../packages/work-app/src/pet-arm-pose.js';
import { PET_CHARACTERS, normalizePetCharacter, isPetCharacter } from '../../packages/work-app/src/pet-characters.js';
const distance = (a: ArmPoint, b: ArmPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('every pose keeps shoulders fixed and both arm segments at their anatomical lengths', () => {
  for (const status of ['idle', 'running', 'waiting', 'completed', 'failed'])
    for (const action of [undefined, 'pat', 'hug', 'spin', 'jump', 'wave'])
      for (let t = 0; t < 3; t += 0.05) {
        petArmTargets(status, action, t, t / 3).forEach((target, i) => {
          const side = i === 0 ? -1 : 1;
          const pose = solvePetArm(side, target);
          assert.deepEqual(pose.shoulder, { x: side * 0.68, y: 0.82, z: 0.24 });
          assert.ok(Math.abs(distance(pose.shoulder, pose.elbow) - ARM_UPPER) < 1e-9);
          assert.ok(Math.abs(distance(pose.elbow, pose.wrist) - ARM_LOWER) < 1e-9);
          for (const [a, b] of [
            [pose.shoulder, pose.elbow],
            [pose.elbow, pose.wrist],
          ])
            for (let k = 0; k <= 10; k++) {
              const f = k / 10,
                p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
              // 在躯干外再留出约 0.1 的手臂外壳厚度。
              assert.ok(
                (p.x / 0.71) ** 2 + ((p.y - 0.55) / 0.76) ** 2 + (p.z / 0.53) ** 2 > 1,
                'arm shell enters torso',
              );
            }
        });
      }
});

test('transitions between raised hands and hugging go below or outside the chin', () => {
  const from = petArmTargets('waiting', undefined, 0)[1];
  const to = petArmTargets('idle', 'hug', 1, 0.4)[1];
  for (let t = 0; t <= 1; t += 0.02) {
    const pose = solvePetArm(1, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
    });
    if (pose.wrist.x < 0.85) assert.ok(pose.wrist.y < 0.76);
  }
});

test('one-piece arm skin closes smoothly and its palm stays clear of the chest badge', () => {
  for (const status of ['idle', 'running', 'waiting', 'completed'])
    for (const action of [undefined, 'pat', 'hug', 'spin', 'jump'])
      for (let t = 0; t < 3; t += 0.05) {
        petArmTargets(status, action, t, t / 3).forEach((target, i) => {
          const skin = petArmSkin(i === 0 ? -1 : 1, target);
          assert.equal(skin[0].radius, 0);
          assert.equal(skin.at(-1)!.radius, 0);
          assert.ok(skin[12].radius > skin[2].radius);
          skin.forEach(({ center: p, radius }, index) => {
            if (index / 24 <= 0.65) return; // 肩根与躯干融合，检查外侧手掌不切进胸牌。
            const dx = Math.max(Math.abs(p.x) - 0.29, 0),
              dy = Math.max(0.26 - p.y, p.y - 0.93, 0),
              dz = Math.max(0.34 - p.z, p.z - 0.555, 0);
            assert.ok(Math.hypot(dx, dy, dz) >= radius - 0.0001);
          });
        });
      }
});

test('unreachable targets keep a finite bent elbow instead of stretching the mesh', () => {
  const pose = solvePetArm(1, { x: 100, y: 10, z: 100 });
  assert.ok(distance(pose.shoulder, pose.wrist) < ARM_UPPER + ARM_LOWER);
  assert.ok(Number.isFinite(pose.elbow.x));
});

test('character catalog validates saved selections and falls back for old or unknown values', () => {
  assert.deepEqual(
    PET_CHARACTERS.map((p) => p.id),
    ['cream-terminal', 'handheld', 'dinosaur', 'byte', 'red-panda'],
  );
  for (const { id } of PET_CHARACTERS) {
    assert.ok(isPetCharacter(id));
    assert.equal(normalizePetCharacter(id), id);
  }
  assert.equal(isPetCharacter('mo'), false);
  assert.equal(normalizePetCharacter('mo'), 'byte');
  assert.equal(normalizePetCharacter('byte'), 'byte');
  assert.equal(normalizePetCharacter('unknown'), 'byte');
  assert.equal(normalizePetCharacter(undefined), 'byte');
});
