import { chat, type ChatTransport } from '../../llm/index.js';
import type { ModelRequest, ModelRunner } from './contracts.js';

class ChatModelRunner implements ModelRunner {
  constructor(
    readonly implementation: 'legacy' | 'staged',
    private readonly transport: ChatTransport,
  ) {}

  run(request: ModelRequest, signal?: AbortSignal) {
    return this.transport(request.history.slice(), request.handlers, signal, request.tools.slice());
  }
}

class LegacyChatModelRunner extends ChatModelRunner {
  constructor(transport: ChatTransport) {
    super('legacy', transport);
  }
}

class StagedChatModelRunner extends ChatModelRunner {
  constructor(transport: ChatTransport) {
    super('staged', transport);
  }
}

/** Legacy and staged bindings are separate rollback seams over the same frozen single-call transport contract. */
export function createLegacyModelRunner(transport: ChatTransport = chat): ModelRunner {
  return new LegacyChatModelRunner(transport);
}

export function createStagedModelRunner(transport: ChatTransport = chat): ModelRunner {
  return new StagedChatModelRunner(transport);
}
