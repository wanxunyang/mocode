import { PetRig } from './pet-rig.js';
import { dot, eyePair, group, oval, paintSurface, sculptSnout, shell, smile, tail, vinyl } from './pet-shapes.js';

function tummy(pet, color, radii, y) {
  const body = shell(pet.root, vinyl(color), [0, y, 0], radii, { outline: 0.85, taper: 0.18 });
  paintSurface(body, color, (ctx) => dot(ctx, 0.5, 0.55, 0.332, 0.355, '#efdbbb'))();
}

export function createDinosaur(scene) {
  const sage = '#aeb991',
    leaf = vinyl(sage),
    custard = vinyl('#f0cd80');
  const pet = new PetRig(scene, 1.25, 0.38);
  tummy(pet, sage, [0.73, 0.72, 0.55], 0.88);
  const skull = shell(pet.head, leaf, [0, 0.63, -0.01], [0.9, 0.775, 0.69], { outline: 0.9, taper: 0.06 });
  sculptSnout(skull, 0.72, -0.28, 0.72, 0.42);
  pet.facePainters.push(
    paintSurface(skull, sage, (ctx, expression) => {
      const noseTint = ctx.createRadialGradient(0.5, 0.65, 0.03, 0.5, 0.65, 0.32);
      noseTint.addColorStop(0, '#bfca9d');
      noseTint.addColorStop(1, sage);
      ctx.fillStyle = noseTint;
      ctx.fillRect(0, 0, 1, 1);
      dot(ctx, 0.13, 0.676, 0.071, 0.064, '#eeb17d', -0.12);
      dot(ctx, 0.87, 0.676, 0.071, 0.064, '#eeb17d', 0.12);
      eyePair(ctx, expression, { y: 0.435, gap: 0.26, rx: 0.055, ry: 0.099, color: '#3c422c', glint: true });
      for (const x of [0.405, 0.595]) dot(ctx, x, 0.56, 0.016, 0.023, '#66734b');
      const y = expression.sad ? 0.765 : 0.739;
      if (!expression.sad) dot(ctx, 0.607, y + 0.061, 0.03, 0.044, '#fff0d3', -0.36);
      smile(ctx, 0.5, y, 0.141, expression.sad ? -0.07 : 0.08, '#566045', 0.016);
    }),
  );
  // 背鳍沿后脑、后背和尾根排成一条线。转身时也能看清小恐龙的轮廓。
  for (const [x, y, z, tilt] of [
    [-0.12, 1.41, -0.035, 0.16],
    [-0.47, 1.24, -0.35, 0.55],
    [-0.69, 0.96, -0.44, 0.94],
    [-0.7, 0.61, -0.49, 1.24],
  ]) {
    const plate = shell(pet.head, custard, [x, y, z], [0.16, 0.208, 0.15], { outline: 0.92, taper: 0.58 });
    plate.rotation.set(-tilt * 0.56, 0, tilt * 0.63);
  }
  oval(pet.root, custard, [0, 1.21, -0.53], [0.13, 0.15, 0.14]);
  pet.tail = group(pet.root, -0.19, 0.59, -0.25);
  const tailMaterial = vinyl('#ffffff');
  tailMaterial.vertexColors = true;
  tail(
    pet.tail,
    tailMaterial,
    [
      [0, 0, 0],
      [-0.22, -0.12, -0.3],
      [-0.48, -0.17, -0.45],
      [-0.71, -0.08, -0.48],
      [-0.87, 0.13, -0.44],
    ],
    (t) => 0.34 * Math.sin(Math.PI * t) ** 0.55 * (1.3 - 0.83 * t),
    () => sage,
  );
  pet.addArms(pet.root, leaf, {
    shoulder: [0.57, 1.18, 0.075],
    reach: [0.96, 1.24, 0.84],
    thickness: 1.14,
    waveOffset: [0.16, -0.07, 0.33],
  });
  pet.addFeet(leaf, 0.345, [0.32, 0.17, 0.356], 0.12);
  return pet;
}

function redPandaMarkings(ctx, expression) {
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(0.5, 0);
    ctx.scale(side, 1);
    // 小熊猫的白眉与脸颊弧纹印在曲面上，转头时沿着脸侧自然消失。
    ctx.fillStyle = '#f3d9af';
    ctx.beginPath();
    ctx.moveTo(0.44, 0.46);
    ctx.bezierCurveTo(0.28, 0.47, 0.24, 0.57, 0.29, 0.7);
    ctx.bezierCurveTo(0.33, 0.81, 0.3, 0.87, 0.24, 0.92);
    ctx.bezierCurveTo(0.445, 0.88, 0.475, 0.71, 0.47, 0.58);
    ctx.closePath();
    ctx.fill();
    dot(ctx, 0.205, 0.3, 0.058, 0.033, '#ffe4bb', 0.24);
    dot(ctx, 0.345, 0.674, 0.057, 0.045, '#eb9261');
    ctx.restore();
  }
  eyePair(ctx, expression, { y: 0.544, gap: 0.184, rx: 0.048, ry: 0.097, color: '#45281d' });
}

export function createRedPanda(scene) {
  const cinnamon = '#c47f50',
    fur = vinyl(cinnamon),
    cream = vinyl('#f1d6b4'),
    cocoa = vinyl('#74503e');
  const pet = new PetRig(scene, 1.27, 0.16);
  tummy(pet, cinnamon, [0.72, 0.59, 0.52], 0.8);
  const skull = shell(pet.head, fur, [0, 0.51, 0.015], [1.045, 0.76, 0.655], { outline: 0.88, taper: 0.08 });
  pet.facePainters.push(paintSurface(skull, cinnamon, redPandaMarkings));
  const muzzle = shell(pet.head, cream, [0, 0.31, 0.574], [0.365, 0.24, 0.15], { outline: 0.9, taper: 0.1 });
  pet.facePainters.push(
    paintSurface(muzzle, '#f1d6ab', (ctx, expression) => {
      smile(ctx, 0.5, expression.sad ? 0.72 : 0.6, 0.162, expression.sad ? -0.12 : 0.136, '#533124', 0.046);
    }),
  );
  oval(pet.head, vinyl('#553224', 0.48), [0, 0.385, 0.711], [0.096, 0.067, 0.046]);
  for (const side of [-1, 1]) {
    const ear = group(pet.head, side * 0.695, 1.1, -0.045);
    ear.rotation.z = ear.userData.rest = -side * 0.35;
    shell(ear, cream, [0, 0, 0], [0.25, 0.325, 0.17], { outline: 0.92, taper: 0.46 });
    shell(ear, cocoa, [0, 0.01, 0.08], [0.168, 0.21, 0.104], { outline: 0.94, taper: 0.4 });
    pet.ears.push(ear);
  }
  pet.tail = group(pet.root, -0.22, 0.5, -0.22);
  const stripeMaterial = vinyl('#ffffff');
  stripeMaterial.vertexColors = true;
  tail(
    pet.tail,
    stripeMaterial,
    [
      [0, 0, 0],
      [-0.28, -0.12, -0.21],
      [-0.62, -0.13, -0.28],
      [-0.83, 0.07, -0.32],
      [-0.9, 0.36, -0.26],
      [-0.86, 0.64, -0.18],
    ],
    (t) => 0.335 * Math.sin(Math.PI * t) ** 0.49,
    (t) => ((t > 0.23 && t < 0.4) || (t > 0.63 && t < 0.79) ? '#f0cfa0' : cinnamon),
  );
  pet.addArms(pet.root, cocoa, {
    shoulder: [0.57, 1.16, 0.09],
    reach: [0.9, 1.18, 0.91],
    thickness: 1.1,
    padMaterial: vinyl('#eaa267'),
    waveOffset: [0.39, -0.13, 0.42],
  });
  pet.addFeet(cocoa, 0.33, [0.31, 0.165, 0.33]);
  return pet;
}
