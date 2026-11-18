import { PetRig, damp } from './pet-rig.js';
import { badge, dot, eyePair, group, oval, paintSurface, shell, smile, vinyl } from './pet-shapes.js';

function robotMaterials() {
  return {
    cream: vinyl('#f1dcc2'),
    sage: vinyl('#9faa90'),
    seafoam: vinyl('#9dbab0'),
    orange: vinyl('#e3985d'),
    honey: vinyl('#e0a44e'),
    glass: vinyl('#2d423c', 0.23),
  };
}

function display(pet, material, position, radii) {
  const glass = shell(pet.head, material, position, radii, { outline: 0.49, depth: 0.75, taper: 0.025 });
  glass.name = 'pet-display';
  glass.userData.part = 'head';
  pet.facePainters.push(
    paintSurface(
      glass,
      '#293d35',
      (ctx, expression) => {
        const tint = ctx.createLinearGradient(0.18, 0, 0.72, 1);
        tint.addColorStop(0, '#415550');
        tint.addColorStop(1, '#263a32');
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, 1, 1);
        ctx.save();
        ctx.translate(0.1, 0.18);
        ctx.rotate(-0.63);
        ctx.scale(0.205, 0.052);
        const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        shine.addColorStop(0, 'rgba(238,248,240,.23)');
        shine.addColorStop(1, 'rgba(238,248,240,0)');
        ctx.fillStyle = shine;
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
        const ink = expression.sad ? '#ffb79b' : expression.status === 'waiting' ? '#ffda8f' : '#ffe3a8';
        dot(ctx, 0.13, 0.705, 0.06, 0.048, '#de8955');
        dot(ctx, 0.87, 0.705, 0.06, 0.048, '#de8955');
        eyePair(ctx, expression, { y: 0.535, gap: 0.203, rx: 0.055, ry: (0.1 * radii[0]) / radii[1], color: ink });
        smile(ctx, 0.5, expression.sad ? 0.7 : 0.655, 0.05, expression.sad ? -0.065 : 0.064, ink, 0.023);
      },
      0.1,
    ),
  );
  return glass;
}

function makeTerminal(scene, handheld) {
  const mat = robotMaterials();
  const pet = new PetRig(scene, 0.34, handheld ? 0.18 : 0.22);
  // 整机一起点头，以机身底部为支点。屏幕及上半身摸头，下半身和小手抱抱。
  pet.headTurn = 0.45;
  pet.head.userData.part = undefined;
  pet.head.userData.headAbove = 1.02;
  const width = handheld ? 0.91 : 1.12;
  shell(pet.head, handheld ? mat.seafoam : mat.cream, [0, 1.1, 0], [width, 1.16, 0.61], {
    outline: handheld ? 0.48 : 0.53,
    depth: 0.65,
    taper: handheld ? 0 : 0.066,
    back: handheld ? mat.cream : mat.sage,
  });
  display(pet, mat.glass, [0, handheld ? 1.51 : 1.37, 0.525], [width * 0.845, handheld ? 0.52 : 0.655, 0.195]);
  if (handheld) {
    const a = 0.083,
      b = 0.225;
    badge(
      pet.head,
      mat.cream,
      [
        [-a, b],
        [a, b],
        [a, a],
        [b, a],
        [b, -a],
        [a, -a],
        [a, -b],
        [-a, -b],
        [-a, -a],
        [-b, -a],
        [-b, a],
        [-a, a],
      ],
      [-0.375, 0.54, 0.566],
      0.026,
    );
    oval(pet.head, mat.honey, [0.29, 0.43, 0.57], [0.13, 0.14, 0.07]);
    oval(pet.head, mat.honey, [0.54, 0.7, 0.575], [0.13, 0.14, 0.07]);
  } else {
    oval(pet.head, mat.orange, [0.21, 2.25, -0.045], [0.215, 0.12, 0.155]);
    oval(pet.head, mat.honey, [0.44, 0.42, 0.54], [0.155, 0.155, 0.072]);
  }
  pet.addArms(pet.head, mat.cream, {
    shoulder: [width - 0.15, 0.83, 0.03],
    reach: [0.91, 1.35, 0.88],
    thickness: 1.04,
  });
  pet.addFeet(mat.sage, handheld ? 0.37 : 0.43, [0.365, 0.19, 0.36]);
  return pet;
}

export const createCreamTerminal = (scene) => makeTerminal(scene, false);
export const createHandheld = (scene) => makeTerminal(scene, true);

function addLaptop(pet) {
  const cover = vinyl('#577452'),
    keys = vinyl('#9baa87'),
    bezel = vinyl('#2e4c40');
  const book = group(pet.root, 0, 0.48, 0.67);
  book.name = 'pet-laptop';
  shell(book, cover, [0, 0, 0], [0.46, 0.05, 0.25], { outline: 0.39, depth: 0.52 });
  const hinge = group(book, 0, 0.035, 0.218);
  shell(hinge, cover, [0, 0.244, 0], [0.465, 0.257, 0.045], { outline: 0.37, depth: 0.58 });
  shell(hinge, bezel, [0, 0.245, -0.035], [0.42, 0.216, 0.016], { outline: 0.38 });
  oval(hinge, vinyl('#f1d6a6'), [0, 0.255, 0.045], [0.043, 0.043, 0.009]);
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 6; col++)
      oval(book, keys, [(col - 2.5) * 0.12, 0.051, row * 0.1 - 0.085], [0.045, 0.012, 0.029]);

  pet.poseLaptop = (targets, status, action, time, dt) => {
    const tucked =
      action === 'wave' ||
      action === 'spin' ||
      action === 'jump' ||
      (!action && (status === 'waiting' || status === 'completed'));
    const hug = action === 'hug';
    const closed = tucked || hug;
    book.position.x = damp(book.position.x, tucked ? -0.48 : 0, dt);
    book.position.y = damp(book.position.y, closed ? 0.55 : 0.48, dt);
    book.position.z = damp(book.position.z, tucked ? 0.46 : 0.67, dt);
    book.rotation.x = damp(book.rotation.x, closed ? 1.32 : -0.08, dt);
    book.rotation.y = damp(book.rotation.y, tucked ? -0.26 : 0, dt);
    book.rotation.z = damp(book.rotation.z, tucked ? -0.16 : 0, dt);
    hinge.rotation.x = damp(hinge.rotation.x, closed ? -1.44 : 0.12, dt);
    if (tucked) {
      targets[0] = { x: -0.79, y: 0.45, z: 0.81 };
    } else if (!hug) {
      for (let i = 0; i < 2; i++) {
        const typing = !action && status === 'running' ? Math.sin(time * 11 + i * Math.PI) * 0.055 : 0;
        targets[i] = { x: (i ? 1 : -1) * 0.39, y: 0.45 + typing, z: 0.82 };
      }
    }
  };
}

export function createComputer(scene) {
  const mat = robotMaterials();
  const pet = new PetRig(scene, 1.19, 0.17);
  const body = shell(pet.root, mat.cream, [0, 0.72, 0], [0.65, 0.54, 0.48], { outline: 0.77, taper: 0.15 });
  paintSurface(body, '#f1dcc2', (ctx) => {
    ctx.fillStyle = '#9faa90';
    ctx.beginPath();
    ctx.moveTo(0.19, 0);
    ctx.lineTo(0.81, 0);
    ctx.bezierCurveTo(0.73, 0.54, 0.27, 0.54, 0.19, 0);
    ctx.fill();
  })();
  // 正面宽高严格相等，屏幕和外壳各自保留一圈柔和的圆角。
  const halfSide = 0.85;
  const monitor = shell(pet.head, mat.cream, [0, 0.75, 0], [halfSide, halfSide, 0.545], {
    outline: 0.39,
    depth: 0.62,
    back: mat.sage,
  });
  monitor.name = 'pet-square-monitor';
  display(pet, mat.glass, [0, 0.755, 0.49], [0.7, 0.69, 0.15]);
  oval(pet.head, mat.honey, [0.32, 1.59, -0.035], [0.135, 0.11, 0.124]);
  pet.addArms(pet.root, mat.cream, { shoulder: [0.49, 0.99, 0.17], reach: [0.92, 1.12, 1.18], thickness: 1.13 });
  pet.addFeet(mat.cream, 0.295, [0.273, 0.165, 0.31], 0.06);
  addLaptop(pet);
  return pet;
}
