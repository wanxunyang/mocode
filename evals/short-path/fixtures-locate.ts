import { createHash } from 'node:crypto';
import type { ShortPathTask } from './types.js';

const examples = [
  { name: 'invoice', symbol: 'formatInvoiceLabel', oldValue: 'Unknown', newValue: 'Pending' },
  { name: 'shipping', symbol: 'formatShippingStatus', oldValue: 'Unassigned', newValue: 'Queued' },
];

const cases = ['known', 'symbol', 'ambiguous'] as const;

export const locateTasks: ShortPathTask[] = cases.flatMap((kind) =>
  examples.map(({ name, symbol, oldValue, newValue }) => {
    const target = `src/reports/${name}-export.js`;
    const source = `export function ${symbol}(value) {\n  const label = value.trim();\n  return label || "${oldValue}";\n}\n`;
    const other = {
      path: `src/preview/${name}-preview.js`,
      content: kind === 'ambiguous' ? source : 'export function renderPreview(value) { return value.trim(); }\n',
    };
    const expected = source.replace(`"${oldValue}"`, `"${newValue}"`);
    const checks = [
      [target, expected],
      [other.path, other.content],
    ]
      .map(([file, text]) => {
        const hash = createHash('sha256').update(text).digest('hex');
        return `assert.equal(digest(${JSON.stringify(file)}), ${JSON.stringify(hash)});`;
      })
      .join('\n');
    const location =
      kind === 'known' ? `修改 ${target} 中的` : kind === 'ambiguous' ? '仅修改报表导出模块里的' : '找到并修改';
    return {
      id: `locate-${kind}-${name}`,
      title: `${kind} / ${symbol}`,
      scenario: 'hinted',
      level: 3,
      goal: `${location} ${symbol} 函数，把空输入时的默认文本从 "${oldValue}" 改为 "${newValue}"。只做这一处修改，无需运行检查。`,
      files: [
        { path: target, content: source },
        other,
        {
          path: 'verify-locate.mjs',
          content:
            "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\n" +
            "const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');\n" +
            `${checks}\n`,
        },
      ],
      verificationCommand: 'node verify-locate.mjs',
      gold: { maxToolCalls: kind === 'ambiguous' ? 3 : 2 },
      expected: { files: [target] },
    };
  }),
);
