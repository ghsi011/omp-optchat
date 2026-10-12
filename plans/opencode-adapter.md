# Add OpenCode without replacing the OMP memory core

This ExecPlan follows `.agent/PLANS.md`. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current.

## Purpose / Big Picture

OpenCode users need the same durable original history and bounded binary summary-tree memory that OMP users have. Add a separate plugin entry point that calls the existing `Memory` and `Store` implementations. Keep the OMP entry point and source layout so later upstream updates remain ordinary Git merges.

The first supported runtime is Linux, including Ubuntu in WSL on Windows. The upstream store relies on Linux file descriptors, private POSIX permissions, and abstract Unix sockets. A native Windows store is a separate project. The adapter must reject unsupported storage environments clearly rather than weaken durable-write or single-writer guarantees.

## Progress

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

## Surprises & Discoveries

The initial instruction search used `potato` and missed official `poteto-mode`. The installed component subset has no mode file, but the official source at its recorded revision supplies the requested workflow. No global installation is needed.

`Store.open` rejects non-Linux platforms. `Memory` itself has no OMP runtime dependency and accepts an injected `Summarize` callback. This provides the likely host boundary.

The installed Windows Bun is 1.3.8, below the package minimum. Verification uses a task-local Linux Bun 1.4.0 in WSL with an empty home and XDG directories.

The repository has no root license and GitHub reports no recognized license. Vendored skill licenses are separate. Preserve upstream notices and make no new licensing claim.

OpenCode marks tool-bearing assistant messages complete before its response loop finishes. Turn selection must consider finish reason, tool parts, parent links, and steering timing. Its plugin loader also ignores configuration-hook errors, so configuration failure must remain visible to awaited admission hooks.

OpenCode returns its instance-dispose HTTP response before teardown finishes. The integration fixture waits for the `server.instance.disposed` event before it stops the process. An earlier fixture failure came from premature termination and did not establish a production disposal defect.

The public hooks cannot inspect the final provider request or select its exact tokenizer. The adapter disables automatic host compaction and pruning, waits for required memory work, and refuses requests that exceed an observed-byte capacity policy. It cannot promise that every provider will accept every admitted request. Active attachments and opaque provider state need explicit boundaries.

An actual process interruption during a tool loop leaves an unfinished host assistant without a completion or error marker. Continuing past it would omit later messages from durable capture. The adapter now requires the latest incoming user to belong to the stable captured prefix, and refuses continuation otherwise. A fresh session works; the old host transcript and durable prefix remain available.

## Decision Log

The canonical decision trail is `docs/development/opencode-decisions.tsv`. It records source pins, design selection, evidence, and corrections. Use the existing OMP implementation as the behavioral baseline. Keep dependency installation, execution, and generated artifacts inside task-owned directories. The user has authorized relevant fork commits and pushes, but no merges, deployments, global configuration changes, or credential changes.

The independent design comparison selected one Store and Memory per session over a separate ingestion journal (13/15 versus 11/15 on the recorded rubric). Source identity and public content share one atomic raw-record append. A small prefix renderer excludes the active raw turn after restart. Historical removals, reorderings and content conflicts fail closed. Ordinary child sessions remain separate; scratch cleanup is limited to children created by this process. The public option for the storage root is `directory`.

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

Run checks from the repository root using Bun 1.4.0. Install the lockfile with `bun install --frozen-lockfile --ignore-scripts`. Review any package that requires an install script before executing it. Run `bun run typecheck`, `bun test tests`, and `OPTCHAT_SMOKE_OMP=./node_modules/.bin/omp bun run smoke` with isolated home and XDG directories. Add the OpenCode verification command to package scripts when the integration fixture exists.

The task-local `.tools/verify-wsl.sh` copies the feature checkout into a dedicated WSL temporary directory and runs a supplied command under a clean environment. It is execution infrastructure, not part of the published plugin. The installed runtime remains unchanged.

## Validation and Acceptance

Done means a pinned real OpenCode process loads the adapter and completes multiple turns using a synthetic loopback model. Old public history is durably retrievable through memory tools, the next inference contains a settled bounded summary view and only the active turn, a tool loop retains its original call/result pairing, and a restart recovers history without duplicate records. Corruption and store conflicts have explicit safe behavior. Child sessions and internal compressor sessions cannot contaminate the main archive. The original OMP suite and smoke continue to pass. The fork's remote feature commit contains the tested source and a reproducible upstream update procedure.

## Idempotence and Recovery

Use temporary stores for all tests. Never rewrite the append-only logs. Test shutdown and restart, interrupted capture, replayed events, and failed compression. Preserve upstream single-writer leases. Use a disposable clone for sync rehearsal so neither main nor the feature branch is rewritten. Do not force-push.

## Artifacts and Notes

Upstream baseline is `12a346478f756bfceceb937d8e3846bd6b039a64`. Official Poteto Mode source is cursor/plugins revision `d73344bee8cf22e53b9d5f4cf5749d38ba38c174`, path `pstack/skills/poteto-mode/SKILL.md`. OpenCode v1.19.0 resolves to `733b2c627e5aec39cb33cc22373bdce33053ef2c`. Keep local private paths and personal skill contents out of published artifacts.

## Interfaces and Dependencies

The existing core constructor is `new Memory(store, summarize, options)`. `Summarize` receives a `CompactionRequest` and `AbortSignal` and returns a summary string. Keep provider access within the OpenCode host SDK. Pin development plugin/SDK dependencies to the version verified by the integration fixture. No independent provider client or new credential store is needed.

## Outcomes & Retrospective

The final feature passes type checking, the static audit of 18 new TypeScript files, and 1,450 tests with three existing skips and zero failures. Both actual-host smoke fixtures pass. OpenCode verification covers three processes, all four tools, durable original retrieval, completed-turn restart, slow and failed summaries, independent sessions, cancellation, capacity refusal, and explicit refusal after an unfinished crash record. The initial missing-workflow conclusion is superseded by the official Poteto Mode discovery.

The adapter adds eight host-specific modules and three small shared-core seams. OMP discovery and System One remain unchanged. Supported OpenCode behavior is memory-only and text-only on Linux/WSL; experimental hooks, opaque provider state and unfinished host records remain explicit limits. The sync rehearsal found upstream unchanged, verified ancestry, and produced no merge or diff. It does not predict future conflict rates.

The feature is published on `ghsi011/omp-optchat` branch `feat/opencode-adapter`. [Draft PR #1](https://github.com/ghsi011/omp-optchat/pull/1) targets the fork's `main`, with no upstream PR or merge. The first published commit was checked against `git ls-remote` and the PR head. Further OpenCode versions and unsupported provider state need a separate compatibility change and the same real-host checks.

Revision note: created after source inspection and official workflow recovery to make the implementation and its acceptance checks reviewable before code.

Revision note (2026-10-12 17:10Z): recorded final test and host evidence, independent corrections, the interrupted-history refusal boundary and the unchanged-upstream rehearsal.

Revision note (2026-10-12 17:13Z): recorded the verified fork push and draft pull request.
