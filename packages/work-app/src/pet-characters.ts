export const PET_CHARACTERS = [
  {
    id: 'cream-terminal',
    name: '奶油小终端',
    englishName: 'Cream terminal',
    description: '奶油色机壳、橘子顶键和豆形小手',
    englishDescription: 'A cream shell, a tangerine switch and tiny bean-shaped hands',
  },
  {
    id: 'handheld',
    name: '海盐掌机',
    englishName: 'Sea-salt handheld',
    description: '海盐绿掌机，带十字键和两颗杏色按钮',
    englishDescription: 'A seafoam pocket console with a cream D-pad and apricot buttons',
  },
  {
    id: 'dinosaur',
    name: '抹茶小恐龙',
    englishName: 'Matcha dinosaur',
    description: '奶黄色背鳍、圆鼻头和一颗小乳牙',
    englishDescription: 'A little green hatchling with custard spines and one baby tooth',
  },
  {
    id: 'byte',
    name: 'Byte · 抱本电脑人',
    englishName: 'Byte · Laptop buddy',
    description: '圆角正方形脑袋，怀里抱着一本绿色小电脑',
    englishDescription: 'A soft square monitor head and a little green laptop to hold',
  },
  {
    id: 'red-panda',
    name: '栗子小熊猫',
    englishName: 'Chestnut red panda',
    description: '栗色脸颊、环纹大尾巴和带肉垫的小爪',
    englishDescription: 'Cinnamon cheeks, a curled ringed tail and soft little paw pads',
  },
] as const;
export type PetCharacterId = (typeof PET_CHARACTERS)[number]['id'];
export function isPetCharacter(value: unknown): value is PetCharacterId {
  return PET_CHARACTERS.some((character) => character.id === value);
}
export function normalizePetCharacter(value: unknown): PetCharacterId {
  return isPetCharacter(value) ? value : 'byte';
}
