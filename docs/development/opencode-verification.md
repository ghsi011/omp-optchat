# OpenCode 2 verification

Verification targets the actual OpenCode **2.0.27** CLI, plugin and client packages. The fixture uses a synthetic HTTP model on loopback with an isolated home, project and configuration. The OMP smoke remains an independent regression gate. OpenCode 1.x results do not establish v2 compatibility.

## Reproduce

Use Linux or WSL with Bun 1.4.0. The shared Store does not support native Windows. Install without package lifecycle scripts.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test tests
OPTCHAT_SMOKE_OMP=./node_modules/.bin/omp bun run smoke
OPTCHAT_SMOKE_OPENCODE=/absolute/path/to/opencode-2.0.27 bun run smoke:opencode
```

The [official OpenCode v2 installer](https://opencode.ai/v2/install) resolves platform binaries from the `@opencode` npm scope. The verified Linux x64 baseline archive is [cli-linux-x64-baseline-2.0.27.tgz](https://registry.npmjs.org/@opencode/cli-linux-x64-baseline/-/cli-linux-x64-baseline-2.0.27.tgz), SHA-256 `acb0c26ebae126d66fe1683b09209a2b29a904a13177c65d5714e9d88dbf7257`. Its executable is `package/bin/opencode`.

The Windows x64 baseline archive is [cli-windows-x64-baseline-2.0.27.tgz](https://registry.npmjs.org/@opencode/cli-windows-x64-baseline/-/cli-windows-x64-baseline-2.0.27.tgz), SHA-256 `4d8b5ae776a54418bc4dc3b34daa0c097c27c80ab44f36c4369cf9323666cb72`. Its executable is `package/bin/opencode.exe`. Both archives matched their registry SHA-512 integrity values before extraction. Both executables reported `opencode v2.0.27` with isolated settings on the Windows development computer and its existing Ubuntu 22.04 WSL distribution. No global PATH, application configuration or credentials changed.

The official release metadata pins source `4d9678a79d6367ad1257c258049075e7a2d0c6c8`. The source was inspected before implementing the v2 plugin. The lockfile uses Effect 4.0.1, matching the pinned host package.

## Current evidence

On the v2 implementation, both OMP 18.9.1 and 18.10.2 dependency cohorts passed `bun test tests`: **1,453 passed, three existing skips, zero failures, 35,292 assertions across 37 files**. Typechecking passed on both cohorts. The TypeScript policy audit passed across all 23 adapter, test and fixture files. Both real OMP smoke runs passed with the v2 dependencies and their unchanged semantic assertions. `git diff --check` passed.

The real OpenCode 2.0.27 fixture passes with three host processes, 17 primary model requests, 31 stateless compressor requests, 17 durable records and 15 binary merge nodes. Real `zoom` retrieves the original 9,268-byte reply. All four memory tools execute through the host. Provider-wire assertions preserve each active tool call/result pair exactly once.

Held compression blocks the parent while an independent session completes. Failed compression and an oversized settled context make zero fallback provider calls. The capacity case measures 55,109 input bytes against 19,904 available after output reservation. Cancellation returns before the held generation is released, and the same session then recovers. These are behavioral fixture observations, not performance or tokenization claims.

The fixture checks both a closed restart and a process killed during an active tool loop. Native v2 recovery preserves the exact canonical and archive prefixes, adds one restart notice, makes one resumed provider request, and repeats zero completed tools. Source identities and original public markers remain unique. A separate regression rejects genuinely unfinished history that blocks stable capture. Project-only configuration is read back with `compaction.auto=false`; manual native compaction is refused before primary dispatch.

The upstream baseline `12a346478f756bfceceb937d8e3846bd6b039a64` passed typechecking, 1,422 tests with three skips and zero failures, and its real OMP smoke before adapter changes.

The first v1 feature head `a704fdce99be5929892e76a5c61a7520e0f82638` had a real [GitHub CI failure](https://github.com/ghsi011/omp-optchat/actions/runs/38282900830) in the OMP latest-cohort smoke. Pinned OMP and the then-current OpenCode smoke passed. OMP 18.10.2 changed the default for structured child output, removing the `yield` tool expected by the synthetic child. Explicit `task.structured: true` in the isolated fixture restores the tested contract. Both OMP 18.9.1 and 18.10.2 pass the unchanged full smoke assertions and typechecks after that one-line correction.

A pre-migration full run passed 1,449 tests, skipped three and failed one OpenCode timeout test; its unchanged six-test file passed immediately on rerun. That is historical flake evidence, not a passing final gate. The v2 suite must avoid depending on a 200 ms scheduling window under full-suite load.

## Review method

The work follows the installed [Poteto Mode](https://github.com/cursor/plugins/blob/d73344bee8cf22e53b9d5f4cf5749d38ba38c174/pstack/skills/poteto-mode/SKILL.md) from pstack 0.15.15. Its official source and companion skills were installed in task-local tooling after authorization. The archive SHA-256 is `688b45ba04427b600a93f5a0929357439cbfdd1b53c80d72e2af1f101d78b8dc`.

Two independent v2 investigations compared a native in-process history reader, a separate service client, and cooperative native compaction. The native Effect design won because uncompacted history is complete and a compaction marker makes its boundary explicit. It avoids service discovery, credentials and a second protocol. Durable idle markers replace v1 turn heuristics. Stateless generation replaces scratch compressor sessions. Implementation and real-host verification have different owners and execution directories. Independent reviews use the configured Codex model, without a model-family diversity claim.

Fresh correctness and standards reviews corrected cancellation cleanup ownership, typed retry-feedback serialization, session-ID branding, safe session-correlated diagnostics, and a short-window timeout test. The retry regression failed before its fix. Final source review found no unresolved concrete defect. The comment review kept the two necessary contract comments, found no suppression shortcuts and deleted none; a final scan found no new source comments.

Model the Domain shaped session ownership and durable idle boundaries. Boundary Discipline requires strict canonical-prefix checks. Make Operations Idempotent keeps source identity and text in one append. Separate Before Serializing Shared State keeps independent session queues. Laziness Protocol preserves the existing Store and Memory. Prove It Works requires actual CLI loopback verification and actual GitHub CI on the pushed head. The corresponding principle instructions were read before applying them.

The [decision trail](opencode-decisions.tsv) records choices and corrections. It is not a performance or cost benchmark.

## Upstream rehearsal

The final detached v2 rehearsal used code commit `bfd0253d522b3d0d7f94a6da5d320cbd9989816b` and freshly fetched upstream `12a346478f756bfceceb937d8e3846bd6b039a64`. `git merge --no-commit --no-ff upstream/main` reported `Already up to date`. Ancestry passed and the worktree remained clean, without a merge commit. This procedure establishes current ancestry, not freedom from future conflicts.

The [draft pull request](https://github.com/ghsi011/omp-optchat/pull/1) records publication status and the actual GitHub CI run for its remote head. Local results do not substitute for that exact-head check. The PR targets the fork and stays unmerged.
