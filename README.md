<img src="./assets/banner-en.svg?v=2" alt="MoCode">

<p align="right">English | <a href="./README.zh-CN.md">简体中文</a></p>

# MoCode

A terminal coding agent: give it a goal, and it **completes it autonomously** — no step-by-step hand-holding required.

MoCode explores your code, reads/writes/edits files, runs shell commands, and searches the web on its own, driving the task forward through a loop of "think → call a tool → observe the result → think again." It works with any OpenAI-compatible endpoint (GLM, DeepSeek, Qwen, local Ollama / vLLM, etc.), runs as a full-screen TUI with streaming output and visible reasoning.

## Why MoCode

MoCode isn't a chat box with a coat of paint — it's an agent that actually gets things done:

- **Autonomous multi-step execution** — In a single conversation, the agent chains multiple steps on its own: read code, edit code, run tests, fix based on errors, and so on. It decides the next step without you nagging it. When it hits a decision point, it calls `ask_human` to pop up a panel and ask you (blocking until you respond).
- **Parallel read-only tools** — Consecutive read-only operations in a turn (reading files, grep, glob, codegraph, web search/fetch) run concurrently, so total time is roughly the slowest single call instead of the sum of all of them. Operations with side effects (writing/editing files) stay sequential to preserve snapshot ordering and data safety.
- **Sub-agents divide and conquer** — Complex tasks can spawn independent sub-agents, each with its own conversation history (isolated from the main thread), an optional restricted toolset, and a step cap. They can explore multiple code areas or directions in parallel and report back only a summary, which the main thread uses to decide what's next.
- **Plan / Auto dual mode** — In `plan` mode the agent is read-only (reads code, queries indexes, searches — never writes to disk, runs commands, or spawns sub-agents) and produces a plan; `auto` mode unlocks the full toolset. The agent can switch between the two on its own — scope out an unfamiliar codebase first, then start making changes.
- **Automatic context compression** — As the context window fills up, a three-tier compression kicks in (trim individual results → compact older tool results in place → summarize older turns), so long sessions never overflow. `/context` shows live token usage; `/compact` triggers manual compression (optionally with a focus hint to preserve what matters).
- **Cross-session long-term memory** — The agent can save project architecture, conventions, and lessons learned as long-term memory, auto-loaded in future sessions. A background process periodically reflects on conversations to mine things worth remembering. Memories can be created, searched, updated, and forgotten, with recall-based decay.
- **Working notepad (todolist)** — For complex multi-step tasks (≥3 file changes / ≥5 tool calls), the agent first writes a plan to `.mocode/plans/<id>.md` (file-based, survives context compression), then ticks each step as it goes. A live progress chip in the TUI status bar shows `plan: [title] (3/7) ▸ [current step]`. `finish` auto-archives completed plans to `plans/archive/`, with explicit `list / delete / unarchive` actions.
- **Interruptible and reversible** — Ctrl+C interrupts the current turn at any time (kills child processes recursively, rolls history back to before the turn started, leaves no half-finished tool calls). `/rollback` restores file changes from per-turn snapshots, with a per-file keep/undo choice — no git dependency required.
- **Sandbox protection** — File reads/writes go through a sandbox that blocks out-of-bounds paths (`../../`, absolute paths outside the root, symlink escapes, etc.), so the agent never touches files outside your working directory.

## Features

- **Streaming output + visible reasoning** — Responses render as they're generated; when the model supports reasoning, the thinking process is visible in real time and auto-collapses to save screen space.
- **Full-screen TUI** — Alt-screen mode with a fixed status bar, scrollback (PgUp/PgDn), typeahead while the agent is running, and auto-prefill for the next turn.
- **Session persistence** — Every turn is saved automatically; `--resume` / `/resume` picks up a past session.
- **Skills system** — Scans directories like `~/.mocode/skills/` automatically; each skill's description is injected into the system prompt, and the model calls `use_skill` to load the full instructions only when relevant (progressive disclosure: skim the summary first, load the body only if needed).
- **Optional desktop pet** — A small floating window (`/pet`) shows a stateful character that mirrors agent activity (idle / thinking / tool running / waiting for human). Works as a separate process over WebSocket; quit it with `/pet quit`. Sits beside the terminal, never blocks it.
- **Slash commands** — `/exit` `/clear` `/context` `/skills` `/compact` `/resume` `/rollback` `/memory` `/reflect` `/init` `/theme` `/model` `/plan` `/auto` `/pet`, with dropdown filtering as you type.

## Installation

Requires Node.js ≥ 18.

```bash
npm install -g mocode-ai
```

This gives you the `mocode` command. Prefer not to install globally? Run it directly with `npx mocode-ai`.

> MoCode checks for new versions on startup and self-updates in the background via `npm i -g mocode-ai@latest` — the update takes effect on the next launch, with zero startup delay and silent failure if offline. This is skipped in dev mode (`npm start`, running via tsx).

### Run from source (development / contributing)

```bash
git clone https://github.com/wanxunyang/mocode.git
cd mocode
npm install
npm start
```

Source runs directly via tsx, no build step. After changing code, restart `npm start` for changes to take effect (tsx loads modules at startup, no hot reload). Runtime dependencies: `openai`, `dotenv`, `fast-glob`; dev dependencies: `tsx`, `typescript`, `@types/node`.

## Configuration

On first use, run the setup wizard to fill in three fields interactively (API base URL / key / model name), written to `~/.mocode/config` (global, works from any directory or terminal):

```bash
mocode config
```

You can also configure it from inside the REPL with the `/model` command (pick a backend preset interactively and fill in each field, applied immediately and persisted). Without configuration, the REPL still opens and prompts you to run `/model`.

You can also hand-edit the config files. MoCode loads them in the following priority order (later entries override earlier ones, only backfilling unset environment variables; anything `export`ed in your shell always takes precedence):

1. `<cwd>/.env` — legacy compatibility, lowest priority (see `.env.example` in the source repo for reference)
2. `~/.mocode/config` — global (written by `/model` and `mocode config`)
3. `<cwd>/.mocode/config` — project-level override, highest priority

Three required fields:

```env
LLM_BASE_URL=https://open.bigmodel.cn/api/v3   # swap in your backend
LLM_API_KEY=your-key-here
LLM_MODEL=glm-4.6                              # swap in your model name
```

Common backend `base_url` values:

| Backend        | base\_url                                           |
| -------------- | ---------------------------------------------------- |
| GLM (Zhipu)    | `https://open.bigmodel.cn/api/v3`                   |
| DeepSeek       | `https://api.deepseek.com`                          |
| Qwen (Alibaba) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Local Ollama   | `http://localhost:11434/v1`                         |
| Local vLLM     | `http://localhost:8000/v1`                          |

> The model must support OpenAI-style function calling, otherwise tools won't be triggered.

### Optional configuration

| Environment variable       | Description                                                          | Default                     |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| `MAX_TOKENS`                | Max tokens per response                                               | unlimited                   |
| `CONTEXT_WINDOW_TOKENS`     | Model context window; must match the real model                      | `128000`                    |
| `COMPACT_THRESHOLD`         | Auto-compaction trigger threshold (fraction of window)                | `0.85`                      |
| `LLM_STREAM_USAGE`          | Include `stream_options.include_usage` on streaming requests for real usage | `true`                |
| `AUTO_COMPACT`               | Auto-compaction master switch                                          | `true`                       |
| `AUTO_REFLECT`               | Background reflection pass master switch (periodically mines memories from conversations) | `true`   |
| `REFLECT_EVERY_N`            | Trigger a background reflection every N turns (runs alongside the agent, non-blocking) | `5`      |
| `ANYSEARCH_API_KEY`         | Web search API key (falls back to anonymous free quota if unset)      | none                         |
| `ANYSEARCH_BASE_URL`        | Search API endpoint                                                    | `https://api.anysearch.com` |
| `SKILLS_DIRS`               | Override the default skill scan directories (platform path separator) | three default directories   |
| `MOCODE_CONTEXT_OPTIMIZE`   | Typed encoding of tool results before they reach the LLM (tree/search/log…); disable for raw passthrough (length trimming only) | `true` |
| `MAX_STEPS`                 | Max agent loop steps per turn (prevents infinite loops)               | `200`                        |
| `SUB_AGENT_MAX_STEPS`       | Default step cap for sub-agents (spawned via the `task` tool)         | `50`                         |
| `SANDBOX_ROOT`               | Sandbox root directory (file operation boundary; falls back to cwd if unset) | none                  |
| `MOCODE_THEME`               | Color theme (default/dark/light…; shell env takes precedence over file) | `default`                   |

## Usage

```bash
mocode                          # new session (run inside your target project directory)
mocode --resume                 # list saved sessions
mocode --resume <id>            # resume a specific session
mocode config                   # edit configuration
```

Running from source uses `npm start` (equivalent to `mocode`, but skips the self-update check).

Once in the REPL, just start chatting. It launches straight into the full-screen TUI, showing a banner (model / backend / working directory / tool list). Responses stream in, with the reasoning section visible in real time before collapsing.

The agent operates in **the working directory it was launched from** — to have it work on a specific project, `cd` into that project before running `mocode`.

## Tools

| Tool             | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `read_file`       | Read a file with line numbers; supports `offset` / `limit`               |
| `write_file`      | Create/overwrite a file, auto-creating parent directories                |
| `edit_file`       | Precise string replacement (`old_string` must match uniquely)            |
| `run_command`     | Run a shell command, merging stdout+stderr, 120s default timeout         |
| `glob`            | Find files by glob pattern (excludes node\_modules/.git)                 |
| `grep`            | Regex content search, pure JS implementation, no `rg` dependency         |
| `codegraph`       | With a `.codegraph/` index built, query symbol source and call chains (more accurate and cheaper than read\_file/grep) |
| `web_search`      | Web search (AnySearch), returns title/URL/snippet/body                   |
| `web_fetch`       | Fetch a URL, cleaning HTML into plain text                                |
| `use_skill`       | Load the full SKILL.md instructions for a given skill                    |
| `ask_human`        | Pop up a Q&A panel at decision points; user picks a preset or types freely (blocks until answered) |
| `switch_mode`      | Switch between `plan` (read-only planning) and `auto` (full execution); the agent can call this itself to explore before acting |
| `drop_context`     | Replace irrelevant old tool results in history with stubs to free up context (preserves tool_call_id pairing, leaves system prompt and current turn untouched, idempotent) |
| `task`             | Spawn a sub-agent for an independent subtask (isolated history, optional restricted toolset, optional step cap); consecutive calls run in parallel automatically, returning only a summary |
| `todolist`         | Working notepad: write a multi-step plan to `.mocode/plans/<id>.md` (survives compression) and tick steps as you go; `finish` auto-archives, with `list / delete / unarchive` for history |
| `memory_save`      | Save a piece of cross-session long-term memory (title indexed, body fetched on demand) |
| `memory_search`    | Search memory bodies by keyword; hits boost the recall count (affects forgetting decay) |
| `memory_list`       | List the memory index (id/title/summary, no body)                        |
| `memory_update`     | Edit a memory in place (id unchanged; correct stale facts / update summary / toggle pin) |
| `memory_forget`     | Forget a memory: archived by default (recoverable), `mode=delete` for a hard delete (pinned memories can't be deleted) |

## Slash commands

| Command           | Purpose                                                              |
| ------------------ | ----------------------------------------------------------------------- |
| `/exit` `/quit`     | Exit MoCode                                                          |
| `/clear`            | Clear history (keeps the system prompt) + clear screen               |
| `/context`          | Show a context usage bar (tokens / message count, estimated or measured) |
| `/skills`           | List discovered skills                                               |
| `/compact`          | Compress history (optionally with a focus hint: `/compact …`)        |
| `/resume`           | Resume a saved session                                                |
| `/rollback`         | Menu to pick a turn to roll back to (↑↓ · Enter)                     |
| `/memory`           | Show memory library: entry count + recent index                       |
| `/reflect`          | Manually trigger a background memory reflection pass                  |
| `/model`            | Configure the LLM (baseURL / apiKey / model / context window), applied immediately + persisted |
| `/init`             | Scan the project and generate `MOCODE.md` project memory (dispatched to the agent) |
| `/theme`            | Switch color theme (↑↓ · Enter, or `/theme <name>` directly)         |
| `/plan`             | Switch to plan mode (read-only exploration + plan output, approve to switch to auto) |
| `/auto`             | Switch back to auto mode (full toolset execution)                     |
| `/pet`              | Toggle the optional desktop pet (floating window mirroring agent state) |
| `/pet skin`         | Pick a pet skin (↑↓ · Enter)                                          |
| `/pet quit`         | Fully shut down the pet process (not just disconnect)                 |

Type `/` to trigger the dropdown menu, keep typing to filter; Esc to cancel.

## Quick verification (after configuring your key)

```
> hello, who are you                  # verify LLM connectivity
> read sample.txt                     # triggers read_file
> change foo to bar in sample.txt     # triggers read_file + edit_file
> list all .txt files in this directory  # triggers glob
> search the code for runAgent        # triggers grep
> run node -e "console.log(1+1)"      # triggers run_command
> search what's new in TypeScript 5.5 # triggers web_search
```

Each step prints `● tool name + argument summary` and `↳ result preview` in the terminal; the agent decides the next step on its own within the loop, with responses streaming in as they're generated.

## Skills

MoCode automatically scans the following directories for skills (each skill is a `<name>/SKILL.md` with frontmatter):

- `~/.claude/skills/`
- `~/.mocode/skills/`
- `<cwd>/.mocode/skills/`

A skill's `description` is injected into the system prompt (progressive disclosure, tier 1); the model calls `use_skill` to load the full body (tier 2) only when the task is relevant. Use `/skills` to see discovered skills.

## Type checking

```bash
npm run typecheck   # tsc --noEmit
```

## Future extensions

MCP tool integration, a permission confirmation UI, and a real worktree-isolated sub-agent mode. The current version is a streaming, reasoning-visible, rollback-capable terminal coding agent with 20 tools, working-notepad planning, cross-session memory, parallel sub-agents, and an optional desktop pet.
