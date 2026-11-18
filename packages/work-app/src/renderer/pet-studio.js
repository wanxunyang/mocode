import * as THREE from './vendor/three.module.js';

// 小窗也需要清楚的屏幕反光。用本地生成的柔光板照明，透明背景可叠在任意桌面上。
function reflectionMap() {
  const width = 128,
    height = 64,
    pixels = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const lat = ((row + 0.5) / height - 0.5) * Math.PI;
    for (let col = 0; col < width; col++) {
      const lon = ((col + 0.5) / width - 0.5) * 2 * Math.PI;
      const x = Math.cos(lat) * Math.cos(lon),
        y = Math.sin(lat),
        z = Math.cos(lat) * Math.sin(lon);
      const key =
        (1 - THREE.MathUtils.smoothstep(Math.abs(y - 0.53), 0.075, 0.14)) *
        (1 - THREE.MathUtils.smoothstep(Math.abs(x + 0.46), 0.28, 0.44)) *
        Math.max(0, z);
      const light = 0.13 + 0.32 * Math.max(y, 0) + 4.5 * key;
      const i = 4 * (row * width + col);
      pixels.set([light * 1.02, light, light * 0.97, 1], i);
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

export function setUpPetStudio(renderer, scene) {
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.environment = reflectionMap();
  scene.environmentIntensity = 0.52;
  scene.add(new THREE.HemisphereLight(0xfff9ef, 0xd9cec1, 1.5));
  for (const [color, intensity, x, y, z] of [
    [0xfff8f1, 1.55, -3.5, 4, 5],
    [0xecf1f3, 0.52, 3, 2, 3],
    [0xffeee0, 0.88, 1.5, 3.5, -3],
  ]) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    if (x < 0) {
      light.target.position.y = 1.25;
      scene.add(light.target);
      light.castShadow = true;
      Object.assign(light.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.1, far: 14 });
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.mapSize.set(512, 512);
      light.shadow.normalBias = 0.017;
      light.shadow.bias = -0.0008;
      light.shadow.radius = 2;
    }
    scene.add(light);
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(48, 48, 1, 48, 48, 48);
  gradient.addColorStop(0, 'rgba(55,40,25,0.24)');
  gradient.addColorStop(0.48, 'rgba(55,40,25,0.12)');
  gradient.addColorStop(1, 'rgba(55,40,25,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.85, 0.23),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.position.set(0, 0.045, -0.52);
  scene.add(shadow);
  const halfHeight = 1.69,
    halfWidth = (halfHeight * 160) / 135;
  const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 30);
  camera.position.set(0, 2.09, 8);
  camera.lookAt(0, 1.5, 0);
  return camera;
}
