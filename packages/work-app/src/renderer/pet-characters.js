import { createComputer, createCreamTerminal, createHandheld } from './pet-model.js';
import { createDinosaur, createRedPanda } from './pet-animals.js';
import { normalizePetCharacter } from '../pet-characters.js';

// 每个工厂返回同一套关节/表情接口，任务监听和交互只维护一份。
const factories = {
  'cream-terminal': createCreamTerminal,
  handheld: createHandheld,
  dinosaur: createDinosaur,
  byte: createComputer,
  'red-panda': createRedPanda,
};
export function createPetCharacter(scene, id) {
  const pet = factories[normalizePetCharacter(id)](scene);
  pet.root.traverse((node) => {
    if (node.isMesh) node.castShadow = node.receiveShadow = true;
  });
  pet.expression(false, false, 1, 0, 'idle');
  pet.pose('idle', undefined, 0, 0, 1);
  return pet;
}
