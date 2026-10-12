# OpenCode verification

The integration fixture uses the real OpenCode CLI with an HTTP model fixture bound to loopback. It creates an isolated home, project and configuration and has no external model credentials. The ordinary OMP smoke remains a separate regression gate.

## Reproduce

Use Linux, including Linux inside WSL, with Bun 1.4.0. The shared Store does not support native Windows. Install the lockfile without lifecycle scripts:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test tests
OPTCHAT_SMOKE_OMP=./node_modules/.bin/omp bun run smoke
OPTCHAT_SMOKE_OPENCODE=/absolute/path/to/opencode-1.19.0 bun run smoke:opencode
```

Use an OpenCode 1.19.0 binary from the [official release](https://github.com/anomalyco/opencode/releases/tag/v1.19.0). The verified Linux x64 baseline archive is `opencode-linux-x64-baseline.tar.gz`, SHA-256 `6334d70db3990721ea454357e9cf2573c8685524ad7769af9d52cbffb7008438`. The release source is `733b2c627e5aec39cb33cc22373bdce33053ef2c`. Do not replace the binary with an unpinned installer pipe.

The Windows development machine ran these checks through its existing Ubuntu 22.04 WSL distribution. Dependencies, binaries and generated test stores were task-local. No global OpenCode, OMP, Bun or credential configuration was changed.

## Evidence

The original upstream baseline at `12a346478f756bfceceb937d8e3846bd6b039a64` passed type checking, 1,422 tests with three skips and zero failures, and its real OMP smoke before adapter changes.

The feature passed the following checks on 2026-10-12 with Bun 1.4.0:

| Gate | Result |
| --- | --- |
| Frozen install without lifecycle scripts | Passed; the lockfile did not change. |
| TypeScript | Passed with `tsc --noEmit`. |
| Full suite | 1,450 passed, three existing skips, zero failures; 35,302 assertions across 35 files. |
| Focused adapter and history tests | 102 passed, zero failures; 1,442 assertions. |
| TypeScript policy audit | No violations in 18 new files. |
| Original OMP smoke | Passed, including real tools, media/task recovery and persisted view restoration. |
| OpenCode 1.19.0 smoke | Passed with three processes, 14 conversation calls and 15 summary calls to the loopback fixture. |

The OpenCode smoke records 14 durable records for its original session, 11 merged tree nodes and a 9,268-byte original answer recovered through memory tools. It verifies tool call/result preservation, reasoning exclusion, completed-turn restart and replay without duplicates. These are synthetic correctness checks, not measurements of real-model cost or quality.

A held summary blocks the parent model while an independent session progresses. A failed summary produces no parent fallback. The final near-limit fixture settles history, then refuses 82,424 observed bytes plus 16,384 reserve against 95,904 usable input units; no request reaches that model. Parent cancellation while a summary is held produces no cancelled-parent model call, and the same session works after the summary is released. An untitled session's main request succeeds despite rejected background title generation.

The fixture starts with automatic compaction and pruning enabled. The running host reports both disabled while preserving `reserved: 2048`. Explicit manual compaction is refused. Process interruption during a tool loop leaves an unfinished host assistant; the next prompt is refused before inference, preserves the canonical transcript and existing archive, and a fresh session works. This is a verified refusal boundary, not successful continuation through that unfinished record.

The local sync rehearsal used a disposable detached worktree at feature code commit `c88afc8bf44c3e435e16f14668e64cd74840aa54`. A fresh upstream fetch still resolved to `12a346478f756bfceceb937d8e3846bd6b039a64`. `git merge --no-commit --no-ff upstream/main` reported `Already up to date`; the ancestry check passed and the worktree had no diff from the feature commit. No merge commit or pull-request merge was created. This proves retained ancestry and the current update procedure, not that future upstream changes will be conflict-free.

## Review method

The work follows the actual [Poteto Mode](https://github.com/cursor/plugins/blob/d73344bee8cf22e53b9d5f4cf5749d38ba38c174/pstack/skills/poteto-mode/SKILL.md) workflow from pstack 0.15.15. This is the official revision recorded by the installed personal pstack components. The full source and the required companion skills were installed in task-local tooling after the user authorized installations. The downloaded source archive's SHA-256 is `688b45ba04427b600a93f5a0929357439cbfdd1b53c80d72e2af1f101d78b8dc`.

Two independent architecture candidates compared atomic source metadata with a separate ingestion journal. A fresh reviewer selected the smaller metadata design and required corrections for active tool loops, restart coverage and swallowed configuration errors. Implementation has one owner; the real-host smoke fixture has another. Reviewers use the configured Codex model, so these are independent reviews without a claim of model-family diversity.

Specification and standards reviews corrected source-prefix validation, steering and shutdown races, scratch-session ownership, active pruned results, shared tool-schema accounting, opaque reasoning and interrupted host history. The final source review found no residual correctness blocker. Targeted regressions are in [admission tests](../../tests/opencode-admission.test.ts), [headroom tests](../../tests/opencode-headroom.test.ts) and [session tests](../../tests/opencode-session.test.ts). A comment and style pass retained only explanations of non-obvious host contracts.

The recorded decisions apply Model the Domain (session ownership and lifecycle), Boundary Discipline (canonical host data at one adapter boundary), Make Operations Idempotent (source identity committed with raw text), Separate Before Serializing Shared State (per-session archives), Laziness Protocol (reuse the existing tree), and Prove It Works (actual CLI loopback checks). The corresponding principle instructions were read before applying them.

The [decision trail](opencode-decisions.tsv) records important choices and corrections. It is an audit record, not a performance or cost benchmark.
