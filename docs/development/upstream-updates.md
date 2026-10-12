# Update from upstream

This fork retains upstream Git history. `origin` is the user's fork and `upstream` is `ericjuta/omp-optchat`. Keep the OpenCode work on a feature branch until it is reviewed in the fork. Do not open its pull request against upstream by accident.

```sh
git remote -v
# origin:   https://github.com/ghsi011/omp-optchat.git
# upstream: https://github.com/ericjuta/omp-optchat.git
git status --short
```

If `upstream` is absent, add it once:

```sh
git remote add upstream https://github.com/ericjuta/omp-optchat.git
```

## Rehearse before changing the shared branch

Start with a clean feature branch. Fetch the public upstream, record its exact commit, and create a disposable worktree. Replace `YYYYMMDD` with the date so earlier rehearsals remain distinguishable.

```sh
git fetch upstream --prune
git rev-parse upstream/main
git worktree add -b sync/upstream-YYYYMMDD ../omp-optchat-sync feat/opencode-adapter
cd ../omp-optchat-sync
git merge --no-commit --no-ff upstream/main
```

This local merge rehearsal does not merge a pull request or publish a change. If Git reports conflicts, inspect both sides and preserve upstream behavior before adapting the OpenCode boundary. If the proposed update is unsuitable, use `git merge --abort` while the merge is still in progress. This command restores the clean rehearsal state; do not use it to discard unrelated work.

The intended upstream integration surface is small:

| Area | Integration rule |
| --- | --- |
| `src/opencode/` | Additive host adapter; adjust when the pinned host contract changes. |
| `src/archive.ts` | Retain strict optional source metadata validation and old-record compatibility. |
| `src/history.ts` | Preserve source metadata during import/export and image migration. |
| `src/memory.ts` | Keep prefix rendering a read of saved tree nodes, separate from scheduling. |
| OMP entry and System One | Preserve upstream behavior and run the existing suite and smoke. |
| Package lock, scripts and CI | Keep both host cohorts reproducible; inspect dependency and install-script changes. |

## Verify the proposed merge

Use Linux and Bun 1.4.0 with a fresh local test environment. Install only the recorded dependencies, then run all gates:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test tests
OPTCHAT_SMOKE_OMP=./node_modules/.bin/omp bun run smoke
OPTCHAT_SMOKE_OPENCODE=/absolute/path/to/opencode-1.19.0 bun run smoke:opencode
git diff --check
```

The smoke fixtures must use local synthetic models and isolated configuration. Inspect the upstream diff for new execution paths before running unfamiliar code. A later OpenCode upgrade is a separate compatibility change: pin its SDK and CLI together, read the changed hook call sites, and rerun the real-host smoke.

After a successful rehearsal, commit the local merge, push the `sync/upstream-YYYYMMDD` branch to **origin**, and open a draft pull request in `ghsi011/omp-optchat` with base `feat/opencode-adapter`. Review and approval remain separate from this procedure. Never force-push the feature branch, reset it to upstream, or merge the PR automatically.

If upstream has not advanced, Git may report `Already up to date`; record that result rather than create an empty merge. It proves ancestry, not that a future change will be conflict-free. The implementation's actual rehearsal and its limits are recorded in [verification](opencode-verification.md).

## Baseline and license

The initial baseline is upstream v0.7.0, commit `12a346478f756bfceceb937d8e3846bd6b039a64`. The original main branch and tags remain available through upstream. Do not rewrite those commits or copy only the current file snapshot.

No repository-wide license was present at that baseline. Preserve upstream notices and record any later licensing change independently of adapter code.
