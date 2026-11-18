import * as THREE from './vendor/three.module.js';

export const vinyl = (color, roughness = 0.72) => new THREE.MeshStandardMaterial({ color, roughness });

export function group(parent, x = 0, y = 0, z = 0) {
  const node = new THREE.Group();
  node.position.set(x, y, z);
  parent.add(node);
  return node;
}

const unitBall = new THREE.SphereGeometry(1, 32, 24);

export function oval(parent, material, position, radii) {
  const mesh = new THREE.Mesh(unitBall, material);
  mesh.position.set(...position);
  mesh.scale.set(...radii);
  parent.add(mesh);
  return mesh;
}

const signedPower = (n, power) => Math.sign(n) * Math.abs(n) ** power;
const shells = new Map();

// 沿深度切圆角截面。正面采用平面投影 UV，彩绘跟着曲面走，背壳有独立材质。
function shellGeometry(outline, depth, taper) {
  const key = [outline, depth, taper].join('/');
  if (shells.has(key)) return shells.get(key);
  const sides = 64,
    rings = 36;
  const positions = [],
    normals = [],
    uv = [],
    indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const phi = Math.PI * (ring / rings - 0.5);
    const radius = Math.max(0, Math.cos(phi)) ** depth;
    const z = signedPower(Math.sin(phi), depth);
    for (let side = 0; side < sides; side++) {
      const theta = (2 * Math.PI * side) / sides;
      const x = radius * signedPower(Math.cos(theta), outline);
      const y = radius * signedPower(Math.sin(theta), outline);
      const width = 1 - taper * y;
      positions.push(x * width, y, z);
      uv.push((x * width + 1) / 2, (y + 1) / 2);
      // 分别对轮廓和深度求导，得到连续法线，圆角和极点都没有折痕。
      const factor = radius > 1e-8 ? radius ** (2 / depth - 2 / outline) : 0;
      const dx = factor * signedPower(x, 2 / outline - 1);
      const dy = factor * signedPower(y, 2 / outline - 1);
      const n = new THREE.Vector3(dx / width, dy + (dx * x * taper) / width, signedPower(z, 2 / depth - 1)).normalize();
      normals.push(n.x, n.y, n.z);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < sides; side++) {
      const a = ring * sides + side,
        b = ring * sides + ((side + 1) % sides);
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.addGroup(0, indices.length / 2, 0);
  geometry.addGroup(indices.length / 2, indices.length / 2, 1);
  shells.set(key, geometry);
  return geometry;
}

export function shell(parent, front, position, radii, { outline = 0.65, depth = 0.78, taper = 0, back = front } = {}) {
  const mesh = new THREE.Mesh(shellGeometry(outline, depth, taper), [back, front]);
  mesh.position.set(...position);
  mesh.scale.set(...radii);
  parent.add(mesh);
  return mesh;
}

// 在同一张头部曲面上塑出口鼻，眼睛、面颊和鼻梁之间保持连续的光影。
export function sculptSnout(mesh, amount, centerY, width, height) {
  const geometry = mesh.geometry.clone();
  const positions = geometry.getAttribute('position'),
    normals = geometry.getAttribute('normal');
  const normal = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i),
      y = positions.getY(i),
      z = positions.getZ(i);
    if (z <= 0) continue;
    const swell = amount * Math.exp(-((x / width) ** 2) - ((y - centerY) / height) ** 2) * z ** 2;
    positions.setZ(i, z + swell);
    // 逆转置雅可比将原来的平滑法线一起变形，极点没有接缝。
    normal.fromBufferAttribute(normals, i);
    normal.z /= 1 + (2 * swell) / z;
    normal.x += (normal.z * 2 * swell * x) / (width * width);
    normal.y += (normal.z * 2 * swell * (y - centerY)) / (height * height);
    normal.normalize();
    normals.setXYZ(i, normal.x, normal.y, normal.z);
  }
  mesh.geometry = geometry;
}

// 实心圆边徽章，用于掌机的十字键。所有坐标以徽章中心为原点。
export function badge(parent, material, points, position, bevel) {
  const shape = new THREE.Shape();
  const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  shape.moveTo(...midpoint(points.at(-1), points[0]));
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const previous = points[(i + points.length - 1) % points.length];
    shape.lineTo(a[0] * 0.83 + previous[0] * 0.17, a[1] * 0.83 + previous[1] * 0.17);
    shape.quadraticCurveTo(...a, a[0] * 0.83 + b[0] * 0.17, a[1] * 0.83 + b[1] * 0.17);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.018,
    bevelEnabled: true,
    bevelSegments: 4,
    steps: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

// 圆滚滚的尾巴沿空间曲线逐渐收尖，环纹顺着横截面绕一整周。
export function tail(parent, material, points, radiusAt, colorAt) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const rings = 64,
    sides = 24;
  const frames = curve.computeFrenetFrames(rings, false);
  const positions = [],
    colors = [],
    indices = [];
  const color = new THREE.Color(),
    offset = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    const t = i / rings,
      center = curve.getPointAt(t),
      radius = radiusAt(t);
    color.set(colorAt(t));
    for (let j = 0; j < sides; j++) {
      const angle = (j / sides) * Math.PI * 2;
      offset
        .copy(center)
        .addScaledVector(frames.normals[i], Math.cos(angle) * radius)
        .addScaledVector(frames.binormals[i], Math.sin(angle) * radius);
      positions.push(offset.x, offset.y, offset.z);
      colors.push(color.r, color.g, color.b);
      if (i < rings) {
        const a = i * sides + j,
          b = i * sides + ((j + 1) % sides);
        indices.push(a, b, a + sides, b, b + sides, a + sides);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  parent.add(mesh);
  return mesh;
}

export function paintSurface(mesh, background, draw, glow = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.scale(512, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = mesh.material[1].clone();
  material.color.set(0xffffff);
  material.map = texture;
  if (glow) {
    material.emissive.set(0xffffff);
    material.emissiveIntensity = glow;
    material.emissiveMap = texture;
  }
  mesh.material[1] = material;
  return (expression) => {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, 1, 1);
    draw(ctx, expression);
    texture.needsUpdate = true;
  };
}

export function dot(ctx, x, y, rx, ry, color, rotation = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

export function smile(ctx, x, y, width, bend, color, weight = 0.02) {
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - width, y);
  ctx.bezierCurveTo(x - width * 0.55, y + bend, x + width * 0.55, y + bend, x + width, y);
  ctx.stroke();
}

export function eyePair(ctx, expression, { y, gap, rx, ry, color, glint = false }) {
  for (const side of [-1, 1]) {
    const x = 0.5 + side * gap + expression.look;
    if (expression.happy) {
      smile(ctx, x, y + 0.012, rx * 1.1, -ry * 0.85, color, rx * 0.56);
    } else {
      dot(ctx, x, y, rx, ry * expression.blink, color);
      if (glint && expression.blink > 0.5) dot(ctx, x + rx * 0.23, y - ry * 0.41, rx * 0.24, ry * 0.15, '#fff3d9');
    }
  }
}
