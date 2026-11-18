export type ArmPoint = { x: number; y: number; z: number };
export const ARM_UPPER = 0.35;
export const ARM_LOWER = 0.4;
const add = (a: ArmPoint, b: ArmPoint): ArmPoint => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: ArmPoint, n: number): ArmPoint => ({ x: a.x * n, y: a.y * n, z: a.z * n });
const sub = (a: ArmPoint, b: ArmPoint): ArmPoint => add(a, mul(b, -1));
const dot = (a: ArmPoint, b: ArmPoint) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: ArmPoint) => Math.hypot(a.x, a.y, a.z);
const unit = (a: ArmPoint) => mul(a, 1 / Math.max(1e-8, length(a)));
const mix = (a: ArmPoint, b: ArmPoint, t: number) => add(mul(a, 1 - t), mul(b, t));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 固定肩座、定长上臂和前臂；肘朝身体外前方弯曲，禁止伸直奇点。 */
export function solvePetArm(side: number, target: ArmPoint) {
  const shoulder = { x: side * 0.68, y: 0.82, z: 0.24 };
  // 两个动作之间也走头部外侧，避免从举手直接插值到抱抱时扫过下巴。
  target = { ...target, y: Math.min(target.y, 0.7 + smooth(0.85, 1.18, Math.abs(target.x)) * 0.6) };
  const offset = sub(target, shoulder),
    direction = unit(offset);
  const distance = Math.max(0.1, Math.min(ARM_UPPER + ARM_LOWER - 0.012, length(offset)));
  const wrist = add(shoulder, mul(direction, distance));
  const along = (ARM_UPPER ** 2 - ARM_LOWER ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, ARM_UPPER ** 2 - along ** 2));
  const pole = { x: side, y: -0.35, z: 1 };
  let bend = sub(pole, mul(direction, dot(pole, direction)));
  if (length(bend) < 0.001) bend = sub({ x: 0, y: 1, z: 0 }, mul(direction, direction.y));
  const elbow = add(add(shoulder, mul(direction, along)), mul(unit(bend), height));
  return { shoulder, elbow, wrist };
}

export function petArmTargets(status: string, action: string | undefined, time: number, progress = 0) {
  const idle = (side: number) => ({ x: side * 0.78, y: 0.54, z: 0.3 });
  let left = idle(-1),
    right = idle(1);
  if (status === 'running' && !action) {
    left = { x: -0.38, y: 0.73 + Math.sin(time * 12) * 0.025, z: 0.88 };
    right = { x: 0.38, y: 0.73 + Math.sin(time * 12 + Math.PI) * 0.025, z: 0.88 };
  }
  if ((status === 'waiting' && !action) || action === 'wave') {
    right = { x: 1.19 + Math.sin(time * 9) * 0.045, y: 1.16 + Math.sin(time * 9) * 0.055, z: 0.4 };
  }
  if (action === 'pat') {
    left = { x: -0.85, y: 0.52, z: 0.38 };
    right = { x: 0.85, y: 0.52, z: 0.38 };
  }
  if (action === 'hug') {
    const close = smooth(0.2, 0.65, time) * (1 - smooth(0.82, 1, progress));
    left = mix({ x: -1.08, y: 0.65, z: 0.45 }, { x: -0.22, y: 0.54, z: 0.81 }, close);
    right = mix({ x: 1.08, y: 0.65, z: 0.45 }, { x: 0.22, y: 0.54, z: 0.81 }, close);
  }
  if (action === 'jump' || (!action && status === 'completed')) {
    left = { x: -1.18, y: 1.16, z: 0.4 };
    right = { x: 1.18, y: 1.16, z: 0.4 };
  }
  if (action === 'spin') {
    left = { x: -1.23, y: 0.7, z: 0.36 };
    right = { x: 1.23, y: 0.7, z: 0.36 };
  }
  return [left, right];
}

/** 一体式软壳：扁椭圆截面、两端收圆，肩到手尖只有一层连续表面。 */
export function petArmSkin(side: number, target: ArmPoint, segments = 24) {
  const j = solvePetArm(side, target);
  const a = { x: side * 0.43, y: 0.75, z: 0.18 };
  const direction = unit(sub(j.wrist, j.elbow));
  const c = add(j.wrist, mul(direction, 0.07));
  const b = {
    x: side * (Math.abs(c.x) < 0.55 ? 0.78 : (Math.abs(a.x) + Math.abs(c.x)) / 2 + 0.025),
    y: (a.y + c.y) / 2,
    z: (a.z + c.z) / 2 + (Math.abs(c.x) < 0.55 ? 0.16 : 0.025),
  };
  return Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    const center = add(add(mul(a, (1 - t) ** 2), mul(b, 2 * (1 - t) * t)), mul(c, t * t));
    const q = t < 0.65 ? (t - 0.65) / 0.65 : (t - 0.65) / 0.35;
    const radius = i === 0 || i === segments ? 0 : 0.18 * Math.sqrt(Math.max(0, 1 - q * q));
    return { center, radius };
  });
}
