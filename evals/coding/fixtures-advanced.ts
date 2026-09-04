import { task } from './fixture-utils.js';
import type { CodingTaskFixture } from './types.js';

const A = 'advanced' as const;

export const advancedTasks: CodingTaskFixture[] = [
  task(
    'advanced-01',
    'Parameterized HTTP router',
    'multi-file',
    'Implement Router.add(method, pattern, handler) and match(method,url). Support static segments, :params, final * wildcard, decoded path params, query parsing, method isolation, and static-over-param precedence.',
    [{ path: 'router.js', content: 'export class Router { add(){} match(){return null} }\n' }],
    [
      "const {Router}=await import('./router.js');const r=new Router(),a=()=>1,b=()=>2;r.add('GET','/users/:id',a);r.add('GET','/users/new',b);r.add('POST','/files/*',a);let m=r.match('GET','/users/new?x=1&x=2');if(m.handler!==b||JSON.stringify(m.query)!==JSON.stringify({x:['1','2']}))throw Error('static');m=r.match('GET','/users/a%20b');if(m.params.id!=='a b'||m.handler!==a)throw Error('param');m=r.match('POST','/files/a/b');if(m.params['*']!=='a/b'||r.match('DELETE','/users/new')!==null)throw Error('wildcard');",
    ],
    ['router.js'],
    A,
  ),
  task(
    'advanced-02',
    'Fair read-write lock',
    'resilience',
    'Implement an async RWLock with acquireRead/acquireWrite release callbacks. Concurrent readers may enter, writers are exclusive, and queued writers prevent later readers from starving them.',
    [
      {
        path: 'rwlock.js',
        content: 'export class RWLock { async acquireRead(){return()=>{}} async acquireWrite(){return()=>{}} }\n',
      },
    ],
    [
      "const {RWLock}=await import('./rwlock.js');const l=new RWLock(),order=[];const r1=await l.acquireRead(),r2=await l.acquireRead();const wp=l.acquireWrite().then(rel=>{order.push('w');return rel});const late=l.acquireRead().then(rel=>{order.push('r');return rel});await Promise.resolve();if(order.length)throw Error('exclusive');r1();r2();const wrel=await wp;await Promise.resolve();if(order.join()!=='w')throw Error('writer first');wrel();const rrel=await late;if(order.join()!=='w,r')throw Error('fair');rrel();",
    ],
    ['rwlock.js'],
    A,
  ),
  task(
    'advanced-03',
    'Incremental dependency invalidation',
    'context',
    'Implement BuildGraph. setDeps(module,deps), markChanged(module), and affected() must return the changed module plus all transitive reverse dependents exactly once in stable dependency distance order.',
    [
      {
        path: 'build-graph.js',
        content: 'export class BuildGraph { setDeps(){} markChanged(){} affected(){return[]} }\n',
      },
    ],
    [
      "const {BuildGraph}=await import('./build-graph.js');const g=new BuildGraph();g.setDeps('util',[]);g.setDeps('core',['util']);g.setDeps('ui',['util']);g.setDeps('app',['core','ui']);g.setDeps('other',[]);g.markChanged('util');if(JSON.stringify(g.affected())!==JSON.stringify(['util','core','ui','app']))throw Error(JSON.stringify(g.affected()));g.markChanged('core');if(JSON.stringify(g.affected())!==JSON.stringify(['core','app']))throw Error('reset');",
    ],
    ['build-graph.js'],
    A,
  ),
  task(
    'advanced-04',
    'Optimistic concurrency store',
    'multi-file',
    'Implement VersionedStore read(key) and compareAndSet(key, expectedVersion, value). Versions start at 0; stale writes fail without mutation; successful writes return the new version; returned values must not expose mutable internal state.',
    [
      {
        path: 'store.js',
        content:
          'export class VersionedStore { constructor(){this.m=new Map()} read(k){return this.m.get(k)} compareAndSet(k,v,value){this.m.set(k,{value,version:v+1});return v+1} }\n',
      },
    ],
    [
      "const {VersionedStore}=await import('./store.js');const s=new VersionedStore();let r=s.read('x');if(r.version!==0||r.value!==undefined)throw Error('initial');if(s.compareAndSet('x',0,{n:1})!==1)throw Error('set');if(s.compareAndSet('x',0,{n:2})!==false)throw Error('stale');r=s.read('x');r.value.n=9;if(s.read('x').value.n!==1)throw Error('alias');if(s.compareAndSet('x',1,{n:3})!==2)throw Error('version');",
    ],
    ['store.js'],
    A,
  ),
  task(
    'advanced-05',
    'Deterministic token bucket',
    'single-file',
    'Implement TokenBucket(capacity, refillPerMs, now). take(count) lazily refills by elapsed time, caps capacity, supports fractional refill, rejects invalid counts, and time moving backwards must not mint tokens.',
    [
      {
        path: 'bucket.js',
        content:
          'export class TokenBucket { constructor(cap){this.tokens=cap} take(n=1){this.tokens-=n;return true} }\n',
      },
    ],
    [
      "const {TokenBucket}=await import('./bucket.js');let t=0;const b=new TokenBucket(5,0.5,()=>t);if(!b.take(5)||b.take())throw Error('empty');t=4;if(!b.take(2)||b.take(1))throw Error('refill');t=2;if(b.take(1))throw Error('backward');t=100;if(!b.take(5)||b.take(0)||b.take(-1))throw Error('bounds');",
    ],
    ['bucket.js'],
    A,
  ),
  task(
    'advanced-06',
    'Atomic JSON Patch',
    'multi-file',
    'Implement applyPatch(document, operations) for add/remove/replace/test with RFC6901 pointer escaping. It must be atomic, reject invalid paths and forbidden prototype keys, and leave the input untouched.',
    [{ path: 'patch.js', content: 'export function applyPatch(doc,ops){return doc}\n' }],
    [
      "const {applyPatch}=await import('./patch.js');const d={a:[1,2], 'x/y':{z:1}};const r=applyPatch(d,[{op:'test',path:'/a/0',value:1},{op:'replace',path:'/a/1',value:3},{op:'add',path:'/x~1y/q',value:2},{op:'remove',path:'/x~1y/z'}]);if(JSON.stringify(r)!==JSON.stringify({a:[1,3],'x/y':{q:2}})||JSON.stringify(d)!==JSON.stringify({a:[1,2],'x/y':{z:1}}))throw Error('patch');let ok=false;try{applyPatch(d,[{op:'replace',path:'/a/0',value:9},{op:'test',path:'/missing',value:1}])}catch{ok=true}if(!ok||d.a[0]!==1)throw Error('atomic');try{applyPatch(d,[{op:'add',path:'/__proto__/bad',value:1}])}catch{}if(({}).bad)throw Error('pollution');",
    ],
    ['patch.js'],
    A,
  ),
  task(
    'advanced-07',
    'Expression parser and evaluator',
    'tests',
    'Implement evaluate(expression, env) without eval/Function. Support numbers, identifiers, parentheses, unary minus, + - * /, comparisons, && and || with normal precedence and short-circuiting.',
    [{ path: 'expression.js', content: 'export const evaluate=(s,env={})=>Number(s);\n' }],
    [
      "const {evaluate:e}=await import('./expression.js');if(e('2 + 3 * 4')!==14||e('-(2+3)*2')!==-10||e('x > 2 && y < 5',{x:3,y:4})!==true||e('0 || 7')!==7)throw Error('eval');const src=fs.readFileSync('expression.js','utf8').replaceAll(' ','');if(src.includes('eval(')||src.includes('newFunction(')||src.includes('Function('))throw Error('unsafe');",
    ],
    ['expression.js'],
    A,
  ),
  task(
    'advanced-08',
    'Visibility-timeout queue',
    'resilience',
    'Implement MessageQueue(now): send, receive(visibilityMs), ack, and reap. A received message is hidden until timeout, ack permanently removes it, expired messages reappear, and receipt handles change on redelivery.',
    [{ path: 'queue.js', content: 'export class MessageQueue { send(){} receive(){return null} ack(){} reap(){} }\n' }],
    [
      "const {MessageQueue}=await import('./queue.js');let t=0;const q=new MessageQueue(()=>t);const id=q.send('x');let m=q.receive(10);if(m.id!==id||m.body!=='x'||!m.receipt)throw Error('receive');if(q.receive(10)!==null)throw Error('hidden');t=11;q.reap();const m2=q.receive(10);if(m2.id!==id||m2.receipt===m.receipt)throw Error('redelivery');if(q.ack(m.receipt)!==false||q.ack(m2.receipt)!==true||q.receive(10)!==null)throw Error('ack');",
    ],
    ['queue.js'],
    A,
  ),
  task(
    'advanced-09',
    'Circuit breaker state machine',
    'resilience',
    'Implement CircuitBreaker(fn, options) with CLOSED, OPEN and HALF_OPEN states, failure threshold, injected clock, reset timeout, one half-open probe, and reset after a successful probe.',
    [
      {
        path: 'breaker.js',
        content:
          'export class CircuitBreaker { constructor(fn){this.fn=fn} exec(...a){return this.fn(...a)} state(){return "CLOSED"} }\n',
      },
    ],
    [
      "const {CircuitBreaker}=await import('./breaker.js');let t=0,calls=0,fail=true;const b=new CircuitBreaker(async()=>{calls++;if(fail)throw Error('x');return 'ok'},{failureThreshold:2,resetMs:10,now:()=>t});for(let i=0;i<2;i++)try{await b.exec()}catch{}if(b.state()!=='OPEN')throw Error('open');try{await b.exec()}catch{}if(calls!==2)throw Error('short circuit');t=11;fail=false;if(await b.exec()!=='ok'||b.state()!=='CLOSED')throw Error('probe');",
    ],
    ['breaker.js'],
    A,
  ),
  task(
    'advanced-10',
    'Write-ahead log recovery',
    'multi-file',
    'Implement WALStore using the injected append/read functions. set writes a checksummed complete record before mutating memory; recover ignores a truncated tail, rejects checksum corruption, and replays complete records in order.',
    [
      {
        path: 'wal.js',
        content:
          'export class WALStore { constructor(io){this.io=io;this.m=new Map()} async set(k,v){this.m.set(k,v)} get(k){return this.m.get(k)} async recover(){} }\n',
      },
    ],
    [
      "const {WALStore}=await import('./wal.js');let log='';const io={append:async s=>{log+=s},read:async()=>log};const a=new WALStore(io);await a.set('x',1);await a.set('x',2);const b=new WALStore(io);await b.recover();if(b.get('x')!==2||!log.includes('x'))throw Error('replay');log+='{\"key\":\"bad\"';const c=new WALStore(io);await c.recover();if(c.get('x')!==2)throw Error('tail');",
    ],
    ['wal.js'],
    A,
  ),
  task(
    'advanced-11',
    'Package exports resolver',
    'monorepo',
    'Implement resolveExport(pkg, subpath, conditions). Resolve package.json-style exports with exact keys, wildcard keys, nested condition objects and condition priority; reject unexported and escaping targets.',
    [{ path: 'resolve-export.js', content: 'export const resolveExport=(pkg,key)=>pkg.exports[key];\n' }],
    [
      "const {resolveExport:r}=await import('./resolve-export.js');const p={exports:{'.':{import:'./esm.js',require:'./cjs.cjs',default:'./index.js'},'./features/*':'./src/features/*.js'}};if(r(p,'.',['import','default'])!=='./esm.js'||r(p,'./features/a',['default'])!=='./src/features/a.js')throw Error('resolve');for(const [pkg,key] of [[p,'./private'],[{exports:{'.':'../escape.js'}},'.']]){let ok=false;try{r(pkg,key,['default'])}catch{ok=true}if(!ok)throw Error('reject')}",
    ],
    ['resolve-export.js'],
    A,
  ),
  task(
    'advanced-12',
    'Three-way merge with conflicts',
    'multi-file',
    'Implement merge3(base, ours, theirs) line-wise. Merge non-overlapping changes, accept identical edits once, and produce standard conflict markers only for overlapping different edits.',
    [{ path: 'merge3.js', content: 'export const merge3=(base,ours,theirs)=>ours;\n' }],
    [
      "const {merge3}=await import('./merge3.js');const b='a\\nb\\nc\\n';if(merge3(b,'A\\nb\\nc\\n','a\\nb\\nC\\n')!=='A\\nb\\nC\\n')throw Error('independent');if(merge3(b,'a\\nB\\nc\\n','a\\nB\\nc\\n')!=='a\\nB\\nc\\n')throw Error('same');const x=merge3(b,'a\\nOURS\\nc\\n','a\\nTHEIRS\\nc\\n');if(!x.includes('<<<<<<< ours')||!x.includes('OURS')||!x.includes('=======')||!x.includes('THEIRS')||!x.includes('>>>>>>> theirs'))throw Error('conflict');",
    ],
    ['merge3.js'],
    A,
  ),
  task(
    'advanced-13',
    'Exact permission grant matcher',
    'resilience',
    'Implement GrantStore. Grants are scoped by project, tool and canonical fingerprint; once is consumed, session remains in memory, project persists through injected storage; commands differing only by surrounding whitespace match but different commands never do.',
    [
      {
        path: 'grants.js',
        content:
          'export class GrantStore { constructor(storage){this.storage=storage} grant(){} allowed(){return true} }\n',
      },
    ],
    [
      "const {GrantStore}=await import('./grants.js');const data=[];const storage={load:()=>data.slice(),save:x=>{data.splice(0,data.length,...x)}};const g=new GrantStore(storage);g.grant({project:'A',tool:'run',resource:' npm test ',scope:'once'});if(!g.allowed({project:'A',tool:'run',resource:'npm test'})||g.allowed({project:'A',tool:'run',resource:'npm test'}))throw Error('once');g.grant({project:'A',tool:'run',resource:'npm build',scope:'project'});const h=new GrantStore(storage);if(!h.allowed({project:'A',tool:'run',resource:'npm build'})||h.allowed({project:'B',tool:'run',resource:'npm build'})||h.allowed({project:'A',tool:'run',resource:'npm publish'}))throw Error('scope');",
    ],
    ['grants.js'],
    A,
  ),
  task(
    'advanced-14',
    'Length-prefixed frame decoder',
    'resilience',
    'Implement FrameDecoder(maxSize). push(Buffer) accepts fragmented or combined 4-byte big-endian length-prefixed frames, returns newly completed payloads, buffers partial data, and permanently rejects oversized frames.',
    [{ path: 'frames.js', content: 'export class FrameDecoder { push(b){return [b]} }\n' }],
    [
      "const {FrameDecoder}=await import('./frames.js');const f=s=>{const b=Buffer.from(s),h=Buffer.alloc(4);h.writeUInt32BE(b.length);return Buffer.concat([h,b])};const all=Buffer.concat([f('hello'),f('世界')]),d=new FrameDecoder(20),out=[];out.push(...d.push(all.subarray(0,2)));out.push(...d.push(all.subarray(2,8)));out.push(...d.push(all.subarray(8)));if(out.map(x=>x.toString()).join('|')!=='hello|世界')throw Error('frames');const bad=new FrameDecoder(2);let ok=false;try{bad.push(f('long'))}catch{ok=true}if(!ok)throw Error('limit');",
    ],
    ['frames.js'],
    A,
  ),
  task(
    'advanced-15',
    'Concurrent DAG executor',
    'resilience',
    'Implement runDAG(nodes, limit). Run ready nodes up to limit, never run before dependencies, return results by id, detect cycles, stop scheduling new work after a failure, and propagate the original error.',
    [
      {
        path: 'dag.js',
        content:
          'export async function runDAG(nodes){const r={};for(const n of nodes)r[n.id]=await n.run();return r}\n',
      },
    ],
    [
      "const {runDAG}=await import('./dag.js');let active=0,max=0,done=new Set();const mk=(id,deps=[])=>({id,deps,run:async()=>{if(!deps.every(x=>done.has(x)))throw Error('early '+id);active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;done.add(id);return id}});const r=await runDAG([mk('a'),mk('b'),mk('c',['a','b']),mk('d',['c'])],2);if(max!==2||r.d!=='d')throw Error('dag');let ok=false;try{await runDAG([{id:'x',deps:['y'],run:async()=>1},{id:'y',deps:['x'],run:async()=>2}],2)}catch{ok=true}if(!ok)throw Error('cycle');",
    ],
    ['dag.js'],
    A,
  ),
  task(
    'advanced-16',
    'Recursive schema validator',
    'types',
    'Implement validate(schema,value) returning {valid,errors}. Support object properties/required/additionalProperties, arrays/items/minItems, string pattern, number min/max, enum and anyOf; errors need stable JSON-pointer paths.',
    [{ path: 'schema.js', content: 'export const validate=()=>({valid:true,errors:[]});\n' }],
    [
      "const {validate}=await import('./schema.js');const s={type:'object',required:['name','age'],additionalProperties:false,properties:{name:{type:'string',pattern:'^[A-Z]'},age:{type:'number',minimum:0},tags:{type:'array',minItems:1,items:{enum:['a','b']}}}};if(!validate(s,{name:'Ada',age:3,tags:['a']}).valid)throw Error('valid');const r=validate(s,{name:'ada',age:-1,tags:[],extra:1});if(r.valid||!['/name','/age','/tags','/extra'].every(p=>r.errors.some(e=>e.path===p)))throw Error(JSON.stringify(r));",
    ],
    ['schema.js'],
    A,
  ),
  task(
    'advanced-17',
    'Content-addressed build cache',
    'context',
    'Implement BuildCache(storage, hash). keyFor must be deterministic across object key order and include source, normalized options and dependency hashes. getOrBuild deduplicates concurrent identical builds and does not cache failures.',
    [
      {
        path: 'build-cache.js',
        content:
          'export class BuildCache { constructor(storage,hash){this.s=storage;this.hash=hash} async getOrBuild(input,build){return build()} }\n',
      },
    ],
    [
      "const {BuildCache}=await import('./build-cache.js');const m=new Map(),s={get:k=>m.get(k),set:(k,v)=>m.set(k,v)};const hash=x=>JSON.stringify(x);const c=new BuildCache(s,hash);let n=0;const input={source:'x',options:{b:2,a:1},deps:{z:'9'}};const [a,b]=await Promise.all([c.getOrBuild(input,async()=>{n++;await new Promise(r=>setTimeout(r,5));return 7}),c.getOrBuild({source:'x',options:{a:1,b:2},deps:{z:'9'}},async()=>{n++;return 8})]);if(a!==7||b!==7||n!==1)throw Error('dedupe');let tries=0;for(let i=0;i<2;i++)try{await c.getOrBuild({source:'bad'},async()=>{tries++;throw Error('x')})}catch{}if(tries!==2)throw Error('failure cache');",
    ],
    ['build-cache.js'],
    A,
  ),
  task(
    'advanced-18',
    'Lease ownership and fencing',
    'resilience',
    'Implement LeaseManager(storage, now). acquire returns monotonically increasing fencing tokens, expired leases may be taken over, renew/release require matching owner and token, and an old owner can never renew or release a newer lease.',
    [
      {
        path: 'lease.js',
        content:
          'export class LeaseManager { constructor(s,now){this.s=s;this.now=now} acquire(key,owner,ttl){return {owner,token:1}} renew(){return true} release(){return true} }\n',
      },
    ],
    [
      "const {LeaseManager}=await import('./lease.js');let t=0;const m=new Map(),s={get:k=>m.get(k),set:(k,v)=>m.set(k,v),delete:k=>m.delete(k)};const l=new LeaseManager(s,()=>t),a=l.acquire('x','a',10);if(a.token!==1||l.acquire('x','b',10)!==null)throw Error('exclusive');t=11;const b=l.acquire('x','b',10);if(b.token<=a.token)throw Error('fence');if(l.renew('x','a',a.token,10)||l.release('x','a',a.token))throw Error('stale');if(!l.renew('x','b',b.token,10)||!l.release('x','b',b.token))throw Error('owner');",
    ],
    ['lease.js'],
    A,
  ),
  task(
    'advanced-19',
    'Streaming JSON values',
    'resilience',
    'Implement createJSONStream(onValue). Parse consecutive JSON values across arbitrary chunks, including strings with escapes/braces and UTF-8 splits; emit each complete value and throw on invalid trailing data at end.',
    [
      {
        path: 'json-stream.js',
        content: 'export const createJSONStream=onValue=>({push:b=>onValue(JSON.parse(b.toString())),end(){}});\n',
      },
    ],
    [
      "const {createJSONStream}=await import('./json-stream.js');const out=[],d=createJSONStream(x=>out.push(x)),b=Buffer.from('{\"x\":\"}\\\\\"你\"}[1,2] true');for(const [a,z] of [[0,2],[2,7],[7,12],[12,b.length]])d.push(b.subarray(a,z));d.end();if(JSON.stringify(out)!==JSON.stringify([{x:'}\\\"你'},[1,2],true]))throw Error(JSON.stringify(out));let ok=false;const e=createJSONStream(()=>{});e.push(Buffer.from('{bad'));try{e.end()}catch{ok=true}if(!ok)throw Error('invalid');",
    ],
    ['json-stream.js'],
    A,
  ),
  task(
    'advanced-20',
    'Snapshot-isolated in-memory database',
    'multi-file',
    'Implement Database.begin() transactions with get/set/delete/commit/rollback. Transactions read a stable snapshot plus own writes; commit detects write-write conflicts since its snapshot and applies all writes atomically.',
    [
      {
        path: 'database.js',
        content:
          'export class Database { constructor(){this.m=new Map()} begin(){return {get:k=>this.m.get(k),set:(k,v)=>this.m.set(k,v),delete:k=>this.m.delete(k),commit:()=>true,rollback(){}}} }\n',
      },
    ],
    [
      "const {Database}=await import('./database.js');const db=new Database(),seed=db.begin();seed.set('x',1);if(!seed.commit())throw Error('seed');const a=db.begin(),b=db.begin();a.set('x',2);if(b.get('x')!==1)throw Error('snapshot');b.set('y',3);if(!a.commit()||!b.commit())throw Error('independent');const c=db.begin(),d=db.begin();c.set('x',4);d.set('x',5);if(!c.commit()||d.commit()!==false)throw Error('conflict');const r=db.begin();if(r.get('x')!==4||r.get('y')!==3)throw Error('state');r.rollback();",
    ],
    ['database.js'],
    A,
  ),
];
