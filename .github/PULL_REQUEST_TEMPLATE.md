## What

<!-- What changed? -->

## Why

<!-- User/problem context and why this approach. -->

## Scope / non-goals

<!-- What is intentionally not part of this PR? -->

## Risk and rollback

<!-- Correctness, compatibility, security, data, multi-stack risks; exact rollback path. -->

## Validation

<!-- List commands actually run and results. Do not mark unexecuted checks as passed. -->

- [ ] Targeted validation:
- [ ] `npm run typecheck` (when applicable)
- [ ] `npm run lint:check` (when applicable)
- [ ] `npm test` (when applicable)
- [ ] Stack-specific build/smoke (Electron/Rust/protocol/public API)

## Coding eval

- Level: not needed / smoke / single task / group / all
- Command and result:
- Cost justification if a model was called:
- [ ] I did not update the baseline, or the PR contains the required full-run maintainer evidence.

## Documentation and architecture

- [ ] User-facing docs/runbooks are updated or not applicable.
- [ ] Protocol/public API/multi-stack changes update consumers, stack-status and ADRs.
- [ ] New ESM imports include `.js`; new tools declare capabilities; user strings include both languages.

## Security and privacy

- [ ] No API keys, tokens, `.env`, real sessions/traces, eval results, logs, private source or user data are included.
- [ ] New dependencies are intentional, pinned as required, and declared in the owning package.
