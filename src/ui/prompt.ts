// 桶文件:保持对外 import 路径不变(from '../ui/prompt.js')
// 实际实现已拆分到 ui/prompt-internal/ 目录下
export { promptWithSlashMenu } from './prompt-internal/editor.js';
export {
  promptTurnPicker,
  promptSessionPicker,
  promptThemePicker,
  promptRevertChoice,
} from './prompt-internal/pickers.js';
export type { SlashCommand, PromptOpts, SessionPickerItem } from './prompt-internal/types.js';
