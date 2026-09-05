// ESLint flat config(ESLint 9)。
//
// 定位:重构期间的护栏,不是风格裁判。
//   - 只关心"会出错 / 代码搬坏了"的问题(unused vars、死代码、条件恒真、空的块);
//   - 不关心格式——格式交给 Prettier(见 .prettierrc,重构收尾后一次性跑);
//   - 不接进 test / prepare:它是可选的检查,不是闸门。
//
// 规则刻意保守起步:先把存量基线压到 0 或接近 0,再逐步收紧。
// 加规则前先跑 `npm run lint` 看新增告警量,别一次性引入几百条噪音。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-tests/**',
      'rust/**',
      'node_modules/**',
      // 桌面子应用(Electron)有自己的工具链,暂不纳入根 lint。
      'packages/**',
      'assets/**',
      'tmp/**',
      'evals/results/**',
      // 运行时产物与本地脚手架(均已在 .gitignore 内):会话落盘、probe 输出、临时任务页。
      '.mocode/**',
      'task_management/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // TS 编译器负责 no-undef;ESLint 版本对 ESM + 类型声明误报多。
      'no-undef': 'off',
      // 空 catch 在 REPL 里有意为之(落盘失败不阻断),放行。
      'no-empty': ['error', { allowEmptyCatch: true }],
      // CLI 项目,console 是产品功能不是调试残留。
      'no-console': 'off',
      // 终端程序:ANSI 转义(\x1b[…m)是家常便饭,不是"可疑控制字符"。
      'no-control-regex': 'off',
      // spinner / 生成器里 `const self = this` 是常见写法,非缺陷。
      '@typescript-eslint/no-this-alias': 'off',
      // 下划线前缀 = 显式忽略。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 存量代码里 any 较多,先 warn,后续按模块清零。
      '@typescript-eslint/no-explicit-any': 'warn',
      // 断言在 TUI 状态机里常见(state 非空由上一分支保证),先不开。
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // `while (true)` 是 REPL 主循环的写法,checkLoops 关掉。
      'no-constant-condition': ['error', { checkLoops: false }],
      '@typescript-eslint/no-unused-expressions': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'evals/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      // 测试里 any 用于构造非法输入,是刻意的。
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
