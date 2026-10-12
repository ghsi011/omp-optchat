# Add OpenCode without replacing the OMP memory core

This ExecPlan follows `.agent/PLANS.md`. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current.

## Purpose / Big Picture

OpenCode users need the same durable original history and bounded binary summary-tree memory that OMP users have. Add a separate plugin entry point that calls the existing `Memory` and `Store` implementations. Keep the OMP entry point and source layout so later upstream updates remain ordinary Git merges.

The first supported runtime is Linux, including Ubuntu in WSL on Windows. The upstream store relies on Linux file descriptors, private POSIX permissions, and abstract Unix sockets. A native Windows store is a separate project. The adapter must reject unsupported storage environments clearly rather than weaken durable-write or single-writer guarantees.

## Progress

The completed items in the first list describe the historical v1 implementation. OpenCode 2 is now the sole target; its remaining gates follow that list.

- [x] Created the fork with all upstream history and separate origin/upstream remotes.
- [x] Located official Poteto Mode at the revision recorded by the installed pstack component skills. The spelling is `poteto-mode`.
- [x] Read the repository rules, memory/store entry points, and official OpenCode plugin documentation.
- [x] Verified an existing Ubuntu 22.04 WSL distribution and a checksum-pinned Bun 1.4.0 archive matching upstream CI.
- [x] Finish independent source exploration and compare two adapter designs.
- [x] Capture the upstream test baseline in an isolated WSL directory.
- [x] (2026-10-12 17:10Z) Implement the adapter, pass 102 focused tests, and correct the review findings.
- [x] (2026-10-12 17:10Z) Pass the real OpenCode CLI smoke, including capacity, cancellation and interrupted-history refusal.
- [x] (2026-10-12 17:10Z) Review independently against requirements and repository standards, then correct findings.
- [x] (2026-10-12 17:10Z) Document installation and version limits; rehearse the current upstream update in a disposable checkout.
- [x] (2026-10-12 17:13Z) Commit and push the feature branch, verify the remote commit, and create draft PR #1 in the fork.

- [x] (2026-10-12 17:39Z) Reproduce the actual latest-OMP CI failure and verify its one-line fixture correction on both SDK cohorts.
- [x] (2026-10-12 17:39Z) Install and version-check official OpenCode 2.0.27 binaries on Windows and WSL.
- [x] (2026-10-12 17:39Z) Independently ground v2 APIs and select native Effect hooks with uncompacted context recovery.
- [x] (2026-10-12 18:43Z) Implement the v2-only adapter and deterministic regression tests.
- [x] (2026-10-12 18:43Z) Pass the real v2 loopback fixture and both OMP cohorts with the final dependencies.
- [x] (2026-10-12 18:44Z) Complete fresh independent reviews and corrections, documentation and upstream rehearsal.
- [x] (2026-10-12 18:49Z) Push the existing draft PR and verify all actual CI jobs on v2 head `7ab4b3abbcf8a3727d3c0df7481e02d0b2cd5a28`. The final documentation record also receives an exact-head CI check; the PR carries that live result.

## Surprises & Discoveries

The initial instruction search used `potato` and missed official `poteto-mode`. The installed component subset has no mode file, but the official source at its recorded revision supplies the requested workflow. No global installation is needed.

`Store.open` rejects non-Linux platforms. `Memory` itself has no OMP runtime dependency and accepts an injected `Summarize` callback. This provides the likely host boundary.

The installed Windows Bun is 1.3.8, below the package minimum. Verification uses a task-local Linux Bun 1.4.0 in WSL with an empty home and XDG directories.

The repository has no root license and GitHub reports no recognized license. Vendored skill licenses are separate. Preserve upstream notices and make no new licensing claim.

In OpenCode 1.19, tool-bearing assistant completion did not establish a whole-turn boundary, and plugin configuration-hook failures could be ignored. Those historical findings prompted separate admission guards. OpenCode 2 instead provides durable idle markers and a single awaited Effect context hook, so the v1 heuristics and hook tickets are removed.

The v1 instance-dispose response arrived before teardown finished. The old fixture had to await its disposal event. V2 lifecycle verification uses the new host's service and plugin-scope contracts.

V2's native configuration requires `compaction.auto=false`; plugins cannot change that setting. The compaction hook provides a refusal guard. The selected admission policy measures the awaited context event, including system content, tools and resolved output allocation. It does not promise exact provider tokens or account for changes by later plugins. Active attachments and opaque state need explicit boundaries.

The v1 crash fixture left an unfinished assistant that blocked safe capture. V2 has its own managed-service restart behavior, including a synthetic restart notice and automatic resumption. The real v2 fixture must verify that recovery preserves the canonical prefix and never duplicates archive records. The adapter requires the latest incoming user to belong to the stable captured prefix and refuses unsafe continuation.

## Decision Log

The canonical decision trail is `docs/development/opencode-decisions.tsv`. It records source pins, design selection, evidence, and corrections. Use the existing OMP implementation as the behavioral baseline. Keep dependency installation, execution, and generated artifacts inside task-owned directories. The user has authorized relevant fork commits and pushes, but no merges, deployments, global configuration changes, or credential changes.

The initial independent design comparison selected one Store and Memory per session over a separate ingestion journal (13/15 versus 11/15 on the recorded rubric). The v2 comparison retained that shared-core boundary and selected the native Effect context hook. Source identity and public content share one atomic raw-record append. A small prefix renderer excludes the active raw turn after restart. Historical removals, reorderings and content conflicts fail closed. Ordinary child sessions remain separate. Compression uses stateless host generation and creates no scratch sessions. The public option for the storage root is `directory`.

The user later explicitly authorized required installations. The full official pstack 0.15.15 and its relevant companion skills are installed in task-local tooling at the provenance revision below; no global skills or settings were changed. The missing `no-comments` skill is in pstack itself, not cursor-team-kit at this revision.

## Throughput Checkpoint

The blocking first steps were source inspection, version pins, an upstream baseline and two independent designs. These completed before production edits.

One owner implements the adapter, shared-core seams and regression tests. A second owner builds the real OpenCode loopback fixture. The lead owns documentation, verification infrastructure and review. Each worker uses separate files and a separate WSL execution directory. Dependency and Git mutations are serialized.

Each session owns its store and queue. Canonical projection, turn selection, persistence and prefix rendering stay with one implementation owner because their invariants cross those files. The host fixture is independent because it exercises public APIs.

## Context and Orientation

`src/index.ts` wires OMP events, tools, and summarization. `src/memory.ts` maintains a view that covers a durable prefix of messages, schedules leaf and parent summaries, and implements navigation. `src/store.ts` fsyncs append-only message and tree files, replays them after restart, publishes view snapshots atomically, and holds the writer lease. `src/archive.ts` validates metadata and image attachments. `src/system1/` implements the OMP-specific judge gates.

The OpenCode adapter belongs under `src/opencode/` with its own entry point. Existing OMP package discovery must remain intact. Any shared change needs OMP regression coverage. OpenCode session identity, turn boundaries, public messages, tool input/output, child sessions, and shutdown ownership must be explicit in the adapter's types.

## Plan of Work

First compare independent designs using pinned OpenCode source. Prefer the design that retains upstream's durable store and exposes the smallest adapter API. Verify hook ordering, complete-message capture, disposal, and recovery before code. A successful design must keep previous raw messages out of inference while retaining the active tool loop. Replayed host events must not duplicate records after a crash.

Build tests before production code. Start with a real Store in an isolated Linux temporary directory and deterministic summaries. Then use the actual pinned OpenCode CLI against a loopback model to verify plugin discovery, message replacement, memory tools, compression, and restart. Capture the provider requests and on-disk archive so success does not depend on the plugin's self-report.

Preserve OMP tests, type checks, and its real-host smoke test. Keep paid providers and personal configurations outside all test environments. Give independent reviewers the final diff and this plan. Fix all reproducible correctness problems and rerun affected checks.

Finish with installation and compatibility documentation, an upstream update procedure, and a disposable merge rehearsal. Commit related behavior and tests together, then documentation and verification artifacts. Verify the pushed feature SHA directly against the fork remote.

## Concrete Steps

Run checks from the repository root using Bun 1.4.0. Install the lockfile with `bun install --frozen-lockfile --ignore-scripts`. Review any package that requires an install script before executing it. Run `bun run typecheck`, `bun test tests`, `OPTCHAT_SMOKE_OMP=./node_modules/.bin/omp bun run smoke`, and `OPTCHAT_SMOKE_OPENCODE=/absolute/path/to/opencode-2.0.27 bun run smoke:opencode` with isolated home and XDG directories.

The task-local `.tools/verify-v2-wsl.sh` copies the feature checkout into a dedicated WSL directory and runs a supplied command under a clean environment. Separate owners use separate execution directories. These helpers and task-local runtimes are execution infrastructure, not part of the published plugin; global runtimes and settings remain unchanged.

## Validation and Acceptance

Done means a real OpenCode 2.0.27 process loads the adapter and completes multiple turns using a synthetic loopback model. Old public history is durably retrievable through memory tools, the next inference contains a settled bounded summary view and the complete active turn, a tool loop retains its original call/result pairing, and a restart recovers history without duplicate records. Corruption and store conflicts have explicit safe behavior. Child sessions and stateless compression cannot contaminate the main archive. The original OMP suite and smoke continue to pass on pinned and latest SDK cohorts. The fork's exact remote feature commit has green actual GitHub CI and a reproducible upstream update procedure. The PR stays draft and unmerged.

## Idempotence and Recovery

Use temporary stores for all tests. Never rewrite the append-only logs. Test shutdown and restart, interrupted capture, replayed events, and failed compression. Preserve upstream single-writer leases. Use a disposable clone for sync rehearsal so neither main nor the feature branch is rewritten. Do not force-push.

## Artifacts and Notes

Upstream baseline is `12a346478f756bfceceb937d8e3846bd6b039a64`. Official Poteto Mode source is cursor/plugins revision `d73344bee8cf22e53b9d5f4cf5749d38ba38c174`, path `pstack/skills/poteto-mode/SKILL.md`. The supported OpenCode 2.0.27 source is `4d9678a79d6367ad1257c258049075e7a2d0c6c8`. The historical v1.19.0 investigation used `733b2c627e5aec39cb33cc22373bdce33053ef2c`; it is not a supported target. Keep local private paths and personal skill contents out of published artifacts.

## Interfaces and Dependencies

The existing core constructor is `new Memory(store, summarize, options)`. `Summarize` receives a `CompactionRequest` and `AbortSignal` and returns a summary string. The v2 entry uses `Plugin.define` from `@opencode/plugin/effect`. Its awaited context hook reads canonical history, waits for summaries and validates admission before changing the request. Its compaction hook refuses destructive host compaction. Compression uses `ctx.generate.text`; tools use native Effect schemas. Plugin, schema and client packages are pinned to 2.0.27 and Effect to 4.0.1. No independent provider client or new credential store is needed.

## Outcomes & Retrospective

The user subsequently changed the target to OpenCode 2 only. The v1 results below are historical evidence, not v2 acceptance. The new pin is OpenCode 2.0.27 at official source `4d9678a79d6367ad1257c258049075e7a2d0c6c8`. Both native Windows and WSL executables passed isolated version checks. Plugin and client development dependencies use 2.0.27. Effect uses the host's 4.0.1 dependency.

The v2 implementation and acceptance gates are complete. Independent source and design reviews verified the single awaited context hook, durable idle turn boundaries, cancellation, and full-history recovery. Production and real-host fixture owners used disjoint files and separate WSL roots. The shared Store and Memory remain the reuse boundary. Actual [GitHub CI run 38293121670](https://github.com/ghsi011/omp-optchat/actions/runs/38293121670) passed all three jobs on remote head `7ab4b3abbcf8a3727d3c0df7481e02d0b2cd5a28`; its push-triggered sibling run also passed. The pstack watcher reported READY with the user's required draft state allowed and no review threads. The PR remains unmerged.

Both OMP cohorts passed 1,453 tests, with three existing skips and zero failures. Both typechecks and real OMP smokes passed. The static audit found no violations in 23 files. The real OpenCode 2.0.27 fixture passed with three processes, four actual tools, binary summary merges, exact raw retrieval, slow and failed compression, independent sessions, cancellation, capacity refusal and native crash recovery. The crash resumed with one new provider request and repeated no completed tools. The 55,109-byte capacity case exceeded its 19,904-unit allowance and made zero provider calls.

The independent review found and corrected lost structured compressor feedback. Another review correction ensures generation cancellation cleanup finishes before the memory owner closes. Regressions cover both. Standards corrections retain native session ID types, correlate safe diagnostics and bound timeout-test observations. No concrete review finding remains unresolved.

The first published head's actual GitHub CI exposed an OMP latest-cohort fixture issue. OMP 18.10.2 defaults structured child output off. Explicitly enabling `task.structured` restores the existing synthetic child's `yield` contract. The unchanged semantic smoke assertions pass on both 18.9.1 and 18.10.2, locally and in the successful v2 GitHub run.

The historical v1 feature passed type checking, the static audit of 18 new TypeScript files, and 1,450 tests with three existing skips and zero failures. Both v1-era actual-host smokes passed locally before GitHub exposed the latest-OMP fixture failure. These results do not certify v2. The initial missing-workflow conclusion is superseded by the official Poteto Mode discovery.

The v2 adapter has nine host-specific modules and retains three small shared-core seams. OMP discovery and System One remain unchanged. Supported OpenCode behavior is memory-only and text-only on Linux/WSL; opaque provider state and unsafe unfinished host records remain explicit limits. The final detached rehearsal at code commit `bfd0253d522b3d0d7f94a6da5d320cbd9989816b` found upstream unchanged at `12a346478f756bfceceb937d8e3846bd6b039a64`, verified ancestry and produced no merge or diff. This does not predict future conflict rates.

The feature is published on `ghsi011/omp-optchat` branch `feat/opencode-adapter`. [Draft PR #1](https://github.com/ghsi011/omp-optchat/pull/1) targets the fork's `main`, with no upstream PR or merge. The first published commit was checked against `git ls-remote` and the PR head. Further OpenCode versions and unsupported provider state need a separate compatibility change and the same real-host checks.

Revision note: created after source inspection and official workflow recovery to make the implementation and its acceptance checks reviewable before code.

Revision note (2026-10-12 17:10Z): recorded final test and host evidence, independent corrections, the interrupted-history refusal boundary and the unchanged-upstream rehearsal.

Revision note (2026-10-12 17:13Z): recorded the verified fork push and draft pull request.

Revision note (2026-10-12 18:44Z): replaced the v1 implementation instructions with the sole supported v2 target; recorded local runtime installation, final native-host evidence, review corrections, both OMP regression cohorts and the v2 upstream rehearsal.

Revision note (2026-10-12 18:49Z): recorded the verified v2 remote head and successful actual GitHub jobs. The draft PR remains the live source for CI on later documentation-only commits.
