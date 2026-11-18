import * as THREE from './vendor/three.module.js';
import { petArmSkin, petArmTargets } from '../pet-arm-pose.js';
import { group, oval, shell } from './pet-shapes.js';

export const damp = (a, b, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-14 * dt));

// 每只手只有一张连续的皮，从埋进身体的肩根一直长到圆圆的指尖。
function makeArm(parent, side, material, { shoulder, reach, thickness = 1, padMaterial, waveOffset = [0, 0, 0] }) {
  const segments = 24,
    sides = 24;
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array((segments + 1) * sides * 3), 3);
  position.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  const indices = [];
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < sides; col++) {
      const a = row * sides + col,
        b = row * sides + ((col + 1) % sides);
      indices.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  geometry.setIndex(indices);
  const arm = new THREE.Mesh(geometry, material);
  arm.name = 'pet-mitten';
  arm.userData.part = 'body';
  parent.add(arm);
  const pad = padMaterial && oval(parent, padMaterial, [0, 0, 0], [0.1, 0.115, 0.022]);
  if (pad) pad.userData.part = 'body';
  const centers = Array.from({ length: segments + 1 }, () => new THREE.Vector3());
  const tangent = new THREE.Vector3(),
    u = new THREE.Vector3(),
    v = new THREE.Vector3();
  const front = new THREE.Vector3(0, 0, 1),
    vertex = new THREE.Vector3(),
    basis = new THREE.Matrix4();
  const wrist = new THREE.Vector3();
  let initialized = false;
  return (target, dt) => {
    if (
      initialized &&
      Math.abs(wrist.x - target.x) + Math.abs(wrist.y - target.y) + Math.abs(wrist.z - target.z) < 0.0004
    )
      return;
    const blend = initialized ? 1 - Math.exp(-14 * dt) : 1;
    wrist.lerp(target, blend);
    initialized = true;
    const skin = petArmSkin(side, wrist, segments);
    const lift = THREE.MathUtils.smoothstep(wrist.y, 0.7, 1.14);
    skin.forEach(({ center }, i) => {
      const bend = Math.sin((Math.PI * i) / segments) * lift;
      const sweep = (lift * i) / segments;
      centers[i].set(
        side * (shoulder[0] + waveOffset[0] * sweep + 0.13 * bend) +
          (center.x - side * 0.43) * reach[0] * (1 - 0.32 * lift),
        shoulder[1] + (center.y - 0.75) * reach[1] * (1 + 0.55 * lift) - 0.065 * bend + waveOffset[1] * sweep,
        shoulder[2] + (center.z - 0.18) * reach[2] + waveOffset[2] * sweep,
      );
    });
    for (let i = 0; i <= segments; i++) {
      tangent.subVectors(centers[Math.min(i + 1, segments)], centers[Math.max(i - 1, 0)]).normalize();
      u.crossVectors(front, tangent);
      if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
      u.normalize();
      v.crossVectors(tangent, u).normalize();
      const radius = skin[i].radius * thickness;
      const thumb = lift * 0.09 * Math.exp(-(((i / segments - 0.67) / 0.14) ** 2));
      for (let j = 0; j < sides; j++) {
        const angle = (j / sides) * Math.PI * 2;
        const cos = Math.cos(angle),
          sin = Math.sin(angle);
        const palm = radius + thumb * Math.max(0, -side * (u.x * cos + v.x * sin)) ** 3;
        vertex
          .copy(centers[i])
          .addScaledVector(u, cos * palm)
          .addScaledVector(v, sin * palm * 0.88);
        position.setXYZ(i * sides + j, vertex.x, vertex.y, vertex.z);
      }
      if (pad && i === 16) {
        pad.position.copy(centers[i]).addScaledVector(v, radius * 0.88 - 0.012);
        basis.makeBasis(vertex.copy(u).negate(), tangent, v);
        pad.quaternion.setFromRotationMatrix(basis);
        pad.visible = wrist.y > 0.83;
      }
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    const normals = geometry.getAttribute('normal');
    for (const end of [0, segments]) {
      tangent.subVectors(centers[end], centers[end ? end - 1 : 1]).normalize();
      for (let j = 0; j < sides; j++) normals.setXYZ(end * sides + j, tangent.x, tangent.y, tangent.z);
    }
    normals.needsUpdate = true;
    geometry.computeBoundingSphere();
  };
}

function heartParticles(scene) {
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.7);
  shape.bezierCurveTo(-1.5, 0.15, -0.7, 1.4, 0, 0.55);
  shape.bezierCurveTo(0.7, 1.4, 1.5, 0.15, 0, -0.7);
  const geometry = new THREE.ShapeGeometry(shape);
  const hearts = Array.from({ length: 6 }, (_, i) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: i % 2 ? 0x92b7a5 : 0xf4a883,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    scene.add(mesh);
    mesh.visible = false;
    return mesh;
  });
  return (action, elapsed) => {
    hearts.forEach((mesh, i) => {
      const life = (elapsed - i * 0.085) * 0.63;
      mesh.visible = Boolean(action) && life > 0 && life < 1;
      if (!mesh.visible) return;
      mesh.position.set(Math.sin(i * 2.4) * (0.85 + life * 0.37), 1.9 + life * 0.95, 0.72);
      mesh.rotation.z = Math.sin(elapsed * 2 + i) * 0.3;
      mesh.scale.setScalar(0.065 * (1 - life * 0.2));
      mesh.material.opacity = Math.sin(life * Math.PI) * 0.8;
    });
  };
}

export class PetRig {
  constructor(scene, headY, restYaw = 0.15) {
    this.root = group(scene);
    this.head = group(this.root, 0, headY, 0);
    this.head.userData.part = 'head';
    this.headTurn = 1;
    this.restYaw = restYaw;
    this.facePainters = [];
    this.feet = [];
    this.ears = [];
    this.effects = heartParticles(scene);
  }

  addArms(parent, material, proportions) {
    this.arms = [-1, 1].map((side) => makeArm(parent, side, material, proportions));
  }

  addFeet(material, spacing, radii, z = 0.07) {
    this.feet = [-1, 1].map((side) => {
      const foot = group(this.root, side * spacing, radii[1], z);
      shell(foot, material, [0, 0, 0], radii, { outline: 0.72, depth: 0.77, taper: 0.16 });
      return foot;
    });
  }

  expression(happy, sad, blink, lookX, status) {
    // 仅当画面有肉眼可见的变化才上传面部纹理。
    const eyeHeight = Math.max(0.09, Math.round(blink * 10) / 10);
    const look = (Math.round(lookX * 8) / 8) * 0.024;
    const key = [happy, sad, eyeHeight, look, status].join('/');
    if (this.faceKey === key) return;
    this.faceKey = key;
    this.facePainters.forEach((paint) => paint({ happy, sad, blink: eyeHeight, look, status }));
  }

  pose(status, action, time, progress, dt) {
    const targets = petArmTargets(status, action, time, progress);
    for (const [i, target] of targets.entries()) {
      const resting = !action && status !== 'completed' && (status !== 'waiting' || i === 0);
      if (resting || action === 'pat' || (action === 'wave' && i === 0)) {
        const side = i === 0 ? -1 : 1;
        const working = status === 'running' && !action;
        target.x = side * (working ? 0.73 : 0.77);
        target.y = working ? 0.41 + Math.sin(time * 5 + i * Math.PI) * 0.045 : 0.25;
        target.z = working ? 0.62 : 0.39;
      }
    }
    this.poseLaptop?.(targets, status, action, time, dt);
    targets.forEach((target, i) => this.arms[i](target, dt));
    if (this.tail) this.tail.rotation.y = Math.sin(time * (action === 'wave' ? 4 : 1.7)) * 0.07;
  }
}
