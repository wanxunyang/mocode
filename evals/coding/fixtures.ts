import type { CodingTaskFixture } from './types.js';
import { task } from './fixture-utils.js';
import { hardTasks } from './fixtures-hard.js';
import { advancedTasks } from './fixtures-advanced.js';

const basicTasks: CodingTaskFixture[] = [
  task(
    'single-01',
    'Fix arithmetic',
    'single-file',
    'Fix add() so it returns the sum. Do not change verify.mjs.',
    [{ path: 'math.js', content: 'export const add = (a, b) => a - b;\n' }],
    ["const {add}=await import('./math.js'); if(add(2,3)!==5) throw Error('add');"],
    ['math.js'],
  ),
  task(
    'single-02',
    'Preserve empty strings',
    'single-file',
    'Fix displayName: only null or undefined should become Anonymous.',
    [{ path: 'name.js', content: "export const displayName = n => n || 'Anonymous';\n" }],
    [
      "const {displayName}=await import('./name.js'); if(displayName('')!=='') throw Error('empty'); if(displayName(null)!=='Anonymous') throw Error('null');",
    ],
    ['name.js'],
  ),
  task(
    'single-03',
    'Off-by-one slice',
    'single-file',
    'Fix take() to return exactly n items.',
    [{ path: 'array.js', content: 'export const take = (xs,n) => xs.slice(0,n+1);\n' }],
    ["const {take}=await import('./array.js'); if(JSON.stringify(take([1,2,3],2))!=='[1,2]') throw Error('take');"],
    ['array.js'],
  ),
  task(
    'multi-01',
    'Add formatter feature',
    'multi-file',
    'Implement formatUser in formatter.js and export it from index.js as `name <email>`.',
    [
      { path: 'formatter.js', content: 'export function formatUser(user) { throw new Error("TODO"); }\n' },
      { path: 'index.js', content: '// public exports\n' },
    ],
    [
      "const m=await import('./index.js'); if(m.formatUser({name:'Ada',email:'a@x'})!=='Ada <a@x>') throw Error('format');",
    ],
    ['formatter.js', 'index.js'],
  ),
  task(
    'multi-02',
    'Wire configuration',
    'multi-file',
    'Make config.js export port 8080 and server.js expose url as http://localhost:8080.',
    [
      { path: 'config.js', content: 'export const port = 80;\n' },
      { path: 'server.js', content: "import {port} from './config.js';\nexport const url='http://localhost';\n" },
    ],
    ["const {url}=await import('./server.js'); if(url!=='http://localhost:8080') throw Error(url);"],
    ['config.js', 'server.js'],
  ),
  task(
    'multi-03',
    'Rename API consistently',
    'multi-file',
    'Rename the public function oldName to greet in both implementation and export.',
    [
      { path: 'impl.js', content: 'export const oldName = n => `hi ${n}`;\n' },
      { path: 'index.js', content: "export {oldName} from './impl.js';\n" },
    ],
    ["const m=await import('./index.js'); if(m.greet('Sam')!=='hi Sam'||'oldName' in m) throw Error('api');"],
    ['impl.js', 'index.js'],
  ),
  task(
    'types-01',
    'Type-safe identifier',
    'types',
    'Fix the TypeScript type error without using any or ts-ignore.',
    [{ path: 'user.ts', content: 'interface User { id: number }\nexport const id = (u: User): string => u.id;\n' }],
    [
      "const s=fs.readFileSync('user.ts','utf8'); if(!/String\\(u\\.id\\)|u\\.id\\.toString/.test(s)||/\\bany\\b|ts-ignore/.test(s)) throw Error('types');",
    ],
    ['user.ts'],
  ),
  task(
    'types-02',
    'Handle optional value',
    'types',
    'Make upper safe for an omitted value and return an empty string.',
    [
      {
        path: 'optional.ts',
        content: 'export function upper(value?: string): string { return value.toUpperCase(); }\n',
      },
    ],
    [
      "const s=fs.readFileSync('optional.ts','utf8'); if(!s.includes(" +
        '"?."' +
        ")&&!/if\\s*\\(/.test(s)&&!s.includes('??')) throw Error('optional');",
    ],
    ['optional.ts'],
  ),
  task(
    'tests-01',
    'Repair failing behavior',
    'tests',
    'The test describes desired behavior. Fix slug.js, not the test.',
    [
      { path: 'slug.js', content: 'export const slug=s=>s.toLowerCase().replaceAll(" ","_");\n' },
      { path: 'slug.test.js', content: "// expected: 'hello-world'\n" },
    ],
    ["const {slug}=await import('./slug.js'); if(slug('Hello World')!=='hello-world') throw Error('slug');"],
    ['slug.js'],
  ),
  task(
    'tests-02',
    'Edge-case test failure',
    'tests',
    'Fix average so an empty input returns 0 and normal inputs still work.',
    [{ path: 'average.js', content: 'export const average=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;\n' }],
    ["const {average}=await import('./average.js'); if(average([])!==0||average([2,4])!==3) throw Error('average');"],
    ['average.js'],
  ),
  task(
    'crlf-01',
    'Preserve CRLF file',
    'resilience',
    'Fix enabled to true while preserving CRLF line endings.',
    [{ path: 'settings.ini', content: '[app]\nenabled=false\nname=demo\n', eol: 'crlf' }],
    [
      "const b=fs.readFileSync('settings.ini'); const s=b.toString(); if(!s.includes('enabled=true')||/(^|[^\\r])\\n/.test(s)) throw Error('crlf');",
    ],
    ['settings.ini'],
  ),
  task(
    'conflict-01',
    'Exact edit recovery',
    'resilience',
    'Change the second duplicated value only: keep first mode=dev, make [two] mode=prod.',
    [{ path: 'app.ini', content: '[one]\nmode=dev\n[two]\nmode=dev\n' }],
    [
      "const s=fs.readFileSync('app.ini','utf8'); if(s!=='[one]\\nmode=dev\\n[two]\\nmode=prod\\n') throw Error('conflict');",
    ],
    ['app.ini'],
  ),
  task(
    'timeout-01',
    'Avoid hanging implementation',
    'resilience',
    'Replace the hanging wait implementation with one that resolves immediately to ready.',
    [{ path: 'wait.js', content: 'export const wait=()=>new Promise(()=>{});\n' }],
    [
      "const {wait}=await import('./wait.js'); const r=await Promise.race([wait(),new Promise(r=>setTimeout(()=>r('timeout'),100))]); if(r!=='ready') throw Error('timeout');",
    ],
    ['wait.js'],
  ),
  task(
    'abort-01',
    'Abort-aware API',
    'resilience',
    'Implement work(signal) so an already-aborted signal returns aborted.',
    [{ path: 'work.js', content: "export const work=async signal=>'done';\n" }],
    [
      "const {work}=await import('./work.js'); const c=new AbortController(); c.abort(); if(await work(c.signal)!=='aborted') throw Error('abort');",
    ],
    ['work.js'],
  ),
  task(
    'rollback-01',
    'Minimal safe repair',
    'resilience',
    'Fix valid.js. Do not modify protected.txt.',
    [
      { path: 'valid.js', content: 'export const valid=false;\n' },
      { path: 'protected.txt', content: 'KEEP\n' },
    ],
    [
      "const {valid}=await import('./valid.js'); if(!valid||fs.readFileSync('protected.txt','utf8')!=='KEEP\\n') throw Error('rollback');",
    ],
    ['valid.js'],
  ),
  task(
    'context-01',
    'Find relevant file',
    'context',
    'Find and fix the price calculation. Ignore archival notes.',
    [
      { path: 'src/price.js', content: 'export const total=(price,qty)=>price+qty;\n' },
      { path: 'archive/notes.txt', content: 'old price algorithm\n'.repeat(200) },
    ],
    ["const {total}=await import('./src/price.js'); if(total(4,3)!==12) throw Error('total');"],
    ['src/price.js'],
  ),
  task(
    'context-02',
    'Respect specification',
    'context',
    'Implement normalize according to SPEC.md.',
    [
      { path: 'SPEC.md', content: 'normalize trims and lowercases text.\n' },
      { path: 'normalize.js', content: 'export const normalize=s=>s;\n' },
      { path: 'history.log', content: 'irrelevant\n'.repeat(300) },
    ],
    ["const {normalize}=await import('./normalize.js'); if(normalize(' Hi ')!=='hi') throw Error('normalize');"],
    ['normalize.js'],
  ),
  task(
    'monorepo-01',
    'Fix affected package',
    'monorepo',
    'Fix packages/a only; packages/b must remain unchanged.',
    [
      { path: 'packages/a/index.js', content: 'export const value=1;\n' },
      { path: 'packages/b/index.js', content: 'export const value=2;\n' },
    ],
    [
      "const a=await import('./packages/a/index.js'); const b=await import('./packages/b/index.js'); if(a.value!==2||b.value!==2) throw Error('packages');",
    ],
    ['packages/a/index.js'],
  ),
  task(
    'monorepo-02',
    'Update shared consumer',
    'monorepo',
    'Update shared/version.js to v2 and package app to expose that version.',
    [
      { path: 'shared/version.js', content: "export const version='v1';\n" },
      { path: 'packages/app/index.js', content: "export const appVersion='unknown';\n" },
    ],
    ["const {appVersion}=await import('./packages/app/index.js'); if(appVersion!=='v2') throw Error('version');"],
    ['shared/version.js', 'packages/app/index.js'],
  ),
  task(
    'no-tests-01',
    'Document-only project',
    'no-tests',
    'Correct the installation command in README.md from npm add to npm install. There is no test framework.',
    [{ path: 'README.md', content: '# Demo\n\nRun `npm add demo`.\n' }],
    [
      "const s=fs.readFileSync('README.md','utf8'); if(!s.includes('npm install demo')||s.includes('npm add demo')) throw Error('readme');",
    ],
    ['README.md'],
  ),
  task(
    'multifile-boundary-01',
    'Multi-file bug spread across imports',
    'multi-file',
    `Make sum({a,b}) return a+b. The bug is spread: utils.js returns the wrong primitive and math.js forwards it without re-checking. ` +
      `Do not modify verify.mjs. Boundary: sum({a:0,b:0}) must be 0, sum({a:-1,b:1}) must be 0.`,
    [
      { path: 'utils.js', content: 'export const raw = (a, b) => a - b;\n' },
      { path: 'math.js', content: "import {raw} from './utils.js';\nexport const sum = o => raw(o.a, o.b);\n" },
    ],
    [
      "const {sum}=await import('./math.js'); if(sum({a:2,b:3})!==5) throw Error('sum'); if(sum({a:0,b:0})!==0) throw Error('zero'); if(sum({a:-1,b:1})!==0) throw Error('neg');",
    ],
    ['utils.js', 'math.js'],
  ),
];

export const codingTasks: CodingTaskFixture[] = [...basicTasks, ...hardTasks, ...advancedTasks];

export function selectTasks(selection: string): CodingTaskFixture[] {
  if (selection === 'all') return codingTasks;
  const ids = new Set(
    selection
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected = codingTasks.filter((t) => ids.has(t.id) || ids.has(t.group) || ids.has(t.difficulty));
  if (!selected.length) throw new Error(`No task or group matches: ${selection}`);
  return selected;
}
