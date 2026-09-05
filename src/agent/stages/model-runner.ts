import { chat } from '../../llm/index.js';
import type { ModelRequest, ModelRunner } from './contracts.js';

class ChatModelRunner implements ModelRunner {
  constructor(readonly implementation: 'legacy' | 'staged') {}

  run(request: ModelRequest, signal?: AbortSignal) {
    return chat(request.history.slice(), request.handlers, signal, request.tools.slice());
  }
}

class LegacyChatModelRunner extends ChatModelRunner {
  constructor() {
    super('legacy');
  }
}

class StagedChatModelRunner extends ChatModelRunner {
  constructor() {
    super('staged');
  }
}

/** Legacy and staged bindings are separate rollback seams over the same frozen single-call transport contract. */
export function createLegacyModelRunner(): ModelRunner {
  return new LegacyChatModelRunner();
}

export function createStagedModelRunner(): ModelRunner {
  return new StagedChatModelRunner();
}
