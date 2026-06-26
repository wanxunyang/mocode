# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal terminal coding agent: **LLM + tool-call loop + 6 tools** (`read_file`, `write_file`, `edit_file`, `run_command`, `glob`, `grep`). It talks to any OpenAI-compatible endpoint (GLM, DeepSeek, Qwen, Ollama, vLLM) via the `openai` SDK and runs as an interactive REPL. The codebase is ~5 small files in `src/`; README and code comments are in Chinese.

## Commands

```bash
npm install        # install deps
npm start          # run the REPL (tsx src/index.ts) — requires a configured .env
npm run typecheck  # tsc --noEmit — the only quality gate
```

There is **no build step, no test suite, no linter**. Source runs directly through `tsx`. To exercise a change, `cd` into a target project and run `npm start` here (the agent operates on `process.cwd()`), then follow the smoke-test transcript in the README.

## Configuration

Copy `.env.example` → `.env` and set the three required vars: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. `MAX_TOKENS` is optional. `config.ts` calls `process.exit(1)` on any missing required var, and falls back to `gpt-4o-mini` if `LLM_MODEL` is unset (note: README examples use `glm-4.6`). **The model must support OpenAI-style function calling** or tools never fire.

## Architecture

The flow spans all five files; read them together:

```
index.ts (REPL) ──> agent.ts (runAgent loop) ──> llm.ts (chat()) ──> OpenAI SDK
                          │                              ▲
                          └──> tools.ts (executeTool) ───┘  (tool results fed back as messages)
config.ts feeds baseURL/apiKey/model/systemPrompt into both llm.ts and index.ts
```

- **`index.ts`** — Holds the single `history: ChatMessage[]` (seeded with the system prompt from `config.ts`) and a readline loop. Slash commands: `/exit` `/quit` (exit), `/clear` (truncate history to length 1, keeping the system prompt). Each user line calls `runAgent(history, line)`. Ends with `process.exit(0)` because the OpenAI client's keep-alive sockets hold the event loop open.
- **`agent.ts`** — `runAgent(history, userInput)` pushes the user message, then loops up to **`MAX_STEPS = 25`** per turn. Each iteration calls `chat(history)`; if the response has `tool_calls`, it pushes the assistant message back into history **verbatim with its `tool_calls`** (required by the OpenAI format), executes each tool, pushes each result as a `role: 'tool'` message keyed by `tool_call_id`, and loops again. When there are no tool calls, it prints the text, pushes the assistant message, and returns. **History is mutated in place and persists across REPL turns** — there is no context compression; long sessions grow without bound.
- **`llm.ts`** — Owns the `OpenAI` client and `chatTools`, the mapping from internal `Tool` definitions to OpenAI `function`-tool schema. `chat()` is **non-streaming** and returns `{ content, toolCalls: [{id, name, arguments(string)}] }`.
- **`tools.ts`** — Defines the `Tool` interface (`{ name, description, parameters(JSON Schema), execute }`), the 6 tool implementations, the `tools` registry array, and the `executeTool(name, argsRaw)` dispatcher.
- **`config.ts`** — Loads `.env` (via `import 'dotenv/config'`), validates required vars, and defines the **system prompt** (Chinese) that instructs the agent on tool use and working principles.

### Conventions that bite if ignored

- **The dispatcher never throws.** `executeTool` wraps `tool.execute` in try/catch and returns every failure — unknown tool, bad JSON arguments, execution error — as a plain string that gets fed back to the LLM. Tools themselves also return error strings (e.g. `edit_file` returns a message when `old_string` isn't found or isn't unique). Don't add `throw` paths expecting callers to catch; the contract is "always return a string."
- **`edit_file` requires the `old_string` to match exactly once** (it counts occurrences and rejects 0 or >1). It uses function-form `replace(() => newStr)` so `$` characters in `new_string` aren't interpreted as replacement patterns — preserve this when editing.
- **ESM with `.js` specifiers.** `package.json` is `"type": "module"` and source imports use `.js` extensions (e.g. `import { chat } from './llm.js'`) even though files are `.ts`. Keep this when adding modules — tsx/Node ESM resolve them correctly.
- **`run_command` picks the shell by platform**: `cmd.exe /c` on win32, `bash -c` elsewhere; merges stdout+stderr; default 120s timeout; truncates output at `MAX_OUTPUT = 20000` chars.
- **`glob`/`grep` hardcode ignores** for `**/node_modules/**` and `**/.git/**`; both cap results (`glob`: 200 paths, `grep`: `MAX_RESULTS = 100` matches). `read_file` caps at `MAX_FILE_LINES = 2000` and returns 1-based line numbers.
- **No tests exist.** After changing tool/agent logic, verify by running the REPL and walking the README smoke-test (read sample.txt, edit foo→bar, glob `*.txt`, grep for `runAgent`, run `node -e "console.log(1+1)"`).

## CodeGraph

This repo is indexed (`.codegraph/` exists). Per the global CodeGraph guidance, use `codegraph_explore` / `codegraph_node` to locate and read symbols before falling back to grep/Read.
