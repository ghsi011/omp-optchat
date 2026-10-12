# OpenCode 2 adapter

This fork adds OpenCode support while retaining the original OMP entry point. It reuses OptChat's append-only archive, binary summary tree and memory tools. The host transcript remains available.

## Supported runtime

The target is **OpenCode 2.0.27**, with `@opencode/plugin` and `@opencode/client` 2.0.27 and the host's Effect 4.0.1. Development uses **Bun 1.4.0**. OpenCode 1.x is unsupported. A different version requires source inspection and the real-host smoke before use.

Run the adapter in Linux or WSL. Store its memory in the Linux filesystem, such as `$HOME/.local/state`. Native Windows and storage under `/mnt/c` are unsupported by the shared Store, which relies on Linux procfs, POSIX ownership and private permissions, directory fsync, and an abstract Unix socket writer lease. OpenCode 2 itself can run on Windows; that does not make this Store portable.

Each session has separate memory. Resuming a session reopens it; ordinary subagent sessions remain separate. Keep OMP and OpenCode storage roots separate because the adapter's source metadata is unknown to older upstream readers.

## Install

Install OpenCode 2 using the [official instructions](https://opencode.ai/v2/docs/). Verify `opencode --version` reports 2.0.27. The [verification guide](development/opencode-verification.md) records the official binary and checksum used here.

Run in Linux or WSL. Use a separate checkout if an existing checkout has local changes.

```sh
git clone https://github.com/ghsi011/omp-optchat.git
cd omp-optchat
git switch feat/opencode-adapter
bun install --frozen-lockfile --ignore-scripts
```

Add this native v2 configuration to the project's `opencode.json`. Replace both paths with absolute Linux paths. The plugin URL must name the `src/opencode` directory, not its `index.ts` file. Keep OptChat last among plugins that modify context.

```json
{
  "compaction": { "auto": false },
  "plugins": [
    {
      "package": "file:///home/me/src/omp-optchat/src/opencode",
      "options": { "directory": "/home/me/.local/state/optchat-opencode" }
    }
  ]
}
```

**Set `compaction.auto` to `false`.** This native setting disables automatic host compaction and overflow recovery. V2 offers no mutable plugin configuration hook, so the adapter cannot set or independently verify it. OptChat also rejects host compaction requests before a completed summary can replace history. It changes no global settings.

Model access uses existing OpenCode configuration. By default compression uses the active model. Its `model` option can select another configured model, for example `{"providerID":"your-provider","id":"your-model"}`. The adapter adds no provider client, API-key variable or credential store. It calls stateless host generation, without scratch sessions or agents. Long records and tree merges cost model calls; no cost or quality savings are claimed from synthetic tests.

## History and recovery

Before primary inference, the adapter reads durable history, validates the archived prefix, appends supported public records, and waits for required summaries. The request contains a historical view and the complete active turn. Durable idle markers delimit completed turns, including steering messages and tool continuations. Source identities and text are committed together, preventing duplicate appends after replay.

In the pinned [history reader](https://github.com/anomalyco/opencode/blob/4d9678a79d6367ad1257c258049075e7a2d0c6c8/packages/core/src/session/history.ts), the only head cut is completed host compaction, and its marker stays in the result. OptChat rejects completed compaction. Start a new session if the host already compacted one. A failed compaction attempt alone does not establish lost history.

Removed, reordered, reverted or changed archived records are rejected. OptChat never rewrites its log to match a destructive host edit. Keep the old transcript and archive for inspection. The real-host fixture verifies automatic recovery after a process is killed during a tool loop: the completed calls/results remain intact, the host adds one restart notice, and one new provider request completes the turn without duplicate archive records. A genuinely unfinished assistant that prevents stable capture of a later incoming prompt is refused; this tested recovery is not a promise that every interruption can resume.

Reasoning is excluded from the public archive. Public text, tool inputs and terminal outputs, including failures, are retained. Text already truncated by OpenCode cannot be recovered. Attachments are pointers and metadata, not retained file bytes or permission to fetch arbitrary paths. Active media and opaque provider state require refusal when their expanded input cannot be bounded.

This adapter is memory-only. OMP's System One gates and `chat_recall` remain in the original adapter. OpenCode permissions control its tools. OMP discovery remains intact.

## Memory tools

| Tool | Input and result |
| --- | --- |
| `zoom` | `id`, power-of-two `n`, optional `offset` and `depth`; saved tree children or original text when `n=1`. |
| `date` | `id`; original record timestamp. |
| `chat_search` | `query`, optional `kind`, `limit` and `before`; exact words in raw text and IDs for `zoom`. |
| `work` | Optional numeric `id` and `offset`; captured subagent reports or a report's original text. |

## Waiting and capacity

The native Effect context hook is awaited before primary generation. Every managed step waits for required leaf summaries and tree merges, including later steps in a tool loop. A held summary cannot admit the old raw transcript. Failure, deadline expiry or an unrenderable prefix stops the request. Independent sessions own separate queues and stores.

Admission measures serialized UTF-8 bytes of replacement messages, system content and tool schemas. It compares them with the current model's context/input limits and resolved output allocation, plus `contextReserveBytes` (default 16,384). One observed byte counts as one conservative input-budget unit. Invalid or unknown model limits are rejected.

This byte policy is not an exact tokenizer or a universal provider guarantee. Later plugins, provider serialization and hidden provider state can alter the request. Keep OptChat last and retain a suitable reserve. The pinned [request builder](https://github.com/anomalyco/opencode/blob/4d9678a79d6367ad1257c258049075e7a2d0c6c8/packages/core/src/session/model-request.ts) and [hook types](https://github.com/anomalyco/opencode/blob/4d9678a79d6367ad1257c258049075e7a2d0c6c8/packages/plugin/src/effect/session.ts) define the observed boundary.

If the settled view and full active turn still exceed policy, the adapter refuses. It never truncates raw text, drops a tool pair, or substitutes a partial summary. Reduce `viewBytes`, reduce active-turn output, or choose a larger model. Lowering the reserve changes policy, not evidence of provider acceptance.

Cancellation interrupts admission without fallback; valid summary work may remain reusable. Shutdown cancels owned compression and closes memory before releasing its writer lease. Corrupt storage and writer conflicts also block inference. Never edit append-only files to clear an error.

## Options

| Option | Purpose |
| --- | --- |
| `directory` | Required absolute Linux root for session stores. |
| `enabled` | `false` leaves ordinary OpenCode behavior. |
| `model` | Optional native provider/model reference for compression. |
| `nodeBytes` | Maximum bytes per summary-tree node. |
| `viewBytes` | Maximum historical view bytes, including the `<chat>` envelope. |
| `compressionTimeoutMs` | Compression and admission deadline. |
| `contextReserveBytes` | Overhead allowance; default 16,384, minimum 1,024. |

## Verify and update

Run the [development gates](development/opencode-verification.md), including both actual-host smokes. They use isolated settings and synthetic loopback models without external provider credentials. Follow [upstream updates](development/upstream-updates.md) to retain upstream Git history.

Upstream has no root license at the recorded baseline. Existing notices are preserved; this fork makes no new licensing claim. Vendored licenses apply to those materials.
