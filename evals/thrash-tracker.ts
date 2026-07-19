process.env.LLM_BASE_URL ||= 'http://localhost/v1';
process.env.LLM_API_KEY ||= 'test';

export {};

const { createThrashTracker } = await import('../src/agent/core.js');

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

{
  const track = createThrashTracker();
  assert(track('read_file', '{"path":"x"}', true) === null, 'successful read has no hint');
  assert(track('read_file', '{"path":"x"}', true) === null, 'repeated successful read has no hint');
  assert(track('glob', '{"pattern":"x"}', true) === null, 'successful glob has no hint');
}

{
  const track = createThrashTracker();
  assert(track('write_file', '{"path":"x"}', false) === null, 'first failure has no hint');
  assert(track('write_file', '{"path":"x"}', false)?.includes('call #2') === true, 'second identical failure warns');
  assert(track('write_file', '{"path":"x"}', true) === null, 'success clears failure streak');
  assert(track('write_file', '{"path":"x"}', false) === null, 'failure after success starts at one');
}

{
  const track = createThrashTracker();
  assert(track('edit_file', 'a', false) === null, 'first edit failure has no hint');
  assert(track('read_file', 'a', false) === null, 'different failed call resets streak');
  assert(track('edit_file', 'a', false) === null, 'non-consecutive matching failure stays at one');
  assert(track('edit_file', 'b', false) === null, 'different arguments reset streak');
  assert(track('edit_file', 'b', false)?.includes('call #2') === true, 'new identical failure streak warns');
}

console.log('thrash tracker regression checks passed');
