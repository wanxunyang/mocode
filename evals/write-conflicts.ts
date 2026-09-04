import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

const root = mkdtempSync(path.join(tmpdir(), 'mocode-write-conflicts-'));

try {
  const { setSandboxRoot } = await import('../src/sandbox/index.js');
  const { setCurrentSessionId } = await import('../src/session/state.js');
  const { buildBasePrompt } = await import('../src/config/index.js');
  const { contentHash } = await import('../src/changeset/index.js');
  const { writeFileTool } = await import('../src/tools/builtins/write-file.js');
  const { editFileTool } = await import('../src/tools/builtins/edit-file.js');

  const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
  };

  setSandboxRoot(root);
  setCurrentSessionId('session-a', root);
  const notes = path.join(root, '.mocode', 'sessions', 'session-a', 'notes.md');
  assert(!existsSync(notes), 'setCurrentSessionId must not pre-create notes.md');

  const prompt = buildBasePrompt('session-b');
  assert(prompt.includes('.mocode/sessions/session-b/notes.md'), 'prompt uses explicit session id');
  assert(!prompt.includes('.mocode/sessions/session-a/notes.md'), 'prompt does not leak global session id');

  const omittedHashCreate = await writeFileTool.execute({
    path: 'new-without-hash.txt',
    content: 'created',
  });
  assert(
    typeof omittedHashCreate !== 'string' && omittedHashCreate.status === 'success',
    'omitted hash creates a missing path',
  );
  assert(
    readFileSync(path.join(root, 'new-without-hash.txt'), 'utf8') === 'created',
    'omitted hash writes expected content',
  );

  writeFileSync(path.join(root, 'existing.txt'), '', 'utf8');
  const createConflict = await writeFileTool.execute({
    path: 'existing.txt',
    content: 'new',
    expected_hash: null,
  });
  assert(
    typeof createConflict !== 'string' && createConflict.code === 'CHANGE_CONFLICT',
    'existing file conflicts with create',
  );
  assert(
    typeof createConflict !== 'string' && createConflict.output.includes('Call read_file'),
    'write conflict gives recovery action',
  );
  assert(readFileSync(path.join(root, 'existing.txt'), 'utf8') === '', 'write conflict leaves disk unchanged');

  const omittedHashConflict = await writeFileTool.execute({
    path: 'existing.txt',
    content: 'overwrite-attempt',
  });
  assert(
    typeof omittedHashConflict !== 'string' && omittedHashConflict.code === 'CHANGE_CONFLICT',
    'omitted hash cannot overwrite an existing path',
  );
  assert(
    readFileSync(path.join(root, 'existing.txt'), 'utf8') === '',
    'omitted hash conflict preserves existing content',
  );

  const staleEdit = await editFileTool.execute({
    path: 'existing.txt',
    old_string: '',
    new_string: 'new',
    expected_hash: contentHash('stale'),
  });
  assert(typeof staleEdit !== 'string' && staleEdit.code === 'CHANGE_CONFLICT', 'stale edit hash conflicts');
  assert(
    typeof staleEdit !== 'string' && staleEdit.output.includes('Do not retry'),
    'edit conflict blocks blind retry',
  );

  console.log('write conflict/session regression checks passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
