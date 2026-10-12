# OpenCode adapter

This fork adds OpenCode support while keeping the original OMP entry point. The adapter reuses OptChat's append-only history, binary summary tree and memory tools. OpenCode's own session transcript remains available.

## Supported runtime

The compatibility target is **OpenCode 1.19.0**, with plugin and SDK packages pinned to the same version. Development uses **Bun 1.4.0**; the upstream package requires Bun 1.3.14 or newer. The adapter uses experimental OpenCode hooks, so other OpenCode versions need the real-host smoke test before use.

The initial adapter supports text conversations and text tool results. Active file/media attachments and known opaque encrypted, redacted or remotely referenced reasoning are rejected because the public hooks cannot bound their expanded model input. Ordinary textual reasoning and signatures can remain in the live turn. Historical attachment pointers can still be archived and searched.

Use Linux or Linux inside WSL. On Windows, run OpenCode and keep the state directory in the WSL Linux filesystem, for example under `$HOME/.local/state`. Native Windows and state directories under `/mnt/c` are unsupported. The shared Store relies on Linux procfs, POSIX ownership and private permissions, file and directory fsync, and an abstract Unix socket writer lease.

Each OpenCode session has its own memory within the selected directory. Resuming a session reopens that memory. A new session or ordinary task child starts separate memory. OMP stores stay separate because this adapter adds source metadata that older upstream readers do not understand.

## Install from this fork

Run these commands inside Linux or WSL. Use a separate checkout if you already have an OMP checkout with local work.

```sh
git clone https://github.com/ghsi011/omp-optchat.git
cd omp-optchat
git switch feat/opencode-adapter
bun install --frozen-lockfile --ignore-scripts
```

Add the plugin to your project's `opencode.json`. Replace both example paths with absolute Linux paths. The first path names the checked-out TypeScript entry point; the second is a private directory for durable memory.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///home/me/src/omp-optchat/src/opencode/index.ts",
      {
        "directory": "/home/me/.local/state/optchat-opencode"
      }
    ]
  ]
}
```

Model access comes through your existing OpenCode configuration. By default the compressor uses the model from the real user message. To choose a different configured model, add `"model": { "providerID": "your-provider", "modelID": "your-model" }` to the plugin options. The adapter adds no provider client, API-key variable or credential store.

Compression makes model calls for long records and tree merges. There is no measured cost-saving claim. Use an appropriate configured model and account for these calls before enabling the adapter on a large existing session.

## Behavior and boundaries

Before inference, the adapter reads canonical OpenCode history, commits supported public records, and waits for settled summaries. The model receives the prior-history view followed by its active user and tool loop. Completed pieces of that live loop may already be in the archive; prefix rendering prevents those records from also appearing in the historical view. The same process freezes the view throughout one response chain. After restart the exact formatting may change, but its historical coverage must remain the same.

The memory tools operate on the calling session's archive:

| Tool | Input and result |
| --- | --- |
| `zoom` | `id`, power-of-two `n`, optional `offset` and `depth`; reads saved tree children or a page of exact original text when `n=1`. |
| `date` | `id`; returns the original record timestamp. |
| `chat_search` | `query`, optional `kind`, `limit` and `before`; finds exact words in original text and returns IDs for `zoom`. |
| `work` | Optional numeric `id` and `offset`; lists captured task reports or reads a report's original text. |

Reasoning parts are excluded. Original tool inputs and canonical terminal outputs, including failures, are retained. Output that OpenCode truncated before persistence cannot be recovered by this adapter. Attachments are recorded as pointers and metadata; file bytes are not archived, and an inline data URL is represented by its digest. File references do not grant permission to read arbitrary local paths or URLs.

The first release is memory-only. OMP's System One rules, prefetch, value scoring, tool gate and `chat_recall` remain in the OMP adapter. OpenCode's own permissions still control its tools. OMP's commands, defaults and package discovery remain unchanged.

Automatic OpenCode compaction and pruning are disabled in the plugin's in-memory configuration. Do not request manual OpenCode compaction while this adapter is enabled: OpenCode persists its compaction marker before the plugin can reject the operation, so that session then requires a fresh session. Sessions that already contain host compaction, a revert marker, removed records, reordered history or changed terminal content are rejected instead of silently replacing the archive. Retain the old archive for inspection. Removing the plugin restores ordinary OpenCode behavior, but does not migrate its memory back into the host transcript.

Archive corruption, a writer conflict or failed compression blocks managed inference. These failures do not fall back to a long transcript or partial summary. Close other writers or resolve the reported storage problem, then restart. Do not edit or truncate OptChat logs to clear an error.

Completed-turn restart restores the archive and tree without duplicate capture. If a process dies during a response, OpenCode can retain an unfinished assistant record with no completion or error marker. The adapter cannot prove that record is immutable. When it blocks capture of the next incoming user, continuation is refused before a model call and requires a fresh session. The old canonical transcript and durable archive are retained. Previously pruned tool results still inside an active loop also require a fresh session.

The compressor uses owned child sessions and a hidden agent with tools denied. Shutdown cancels compression and closes stores. Cleanup only deletes scratch children created by the current process. Unproved scratch children left by a crash are retained; ordinary task children and parent sessions are never deleted. The public hooks supply no parent cancellation signal, so a cancelled parent can leave summary work running until completion or the configured deadline. Valid completed summaries remain reusable.

## Waiting and context headroom

Every managed model step waits for OptChat's required summaries before OpenCode converts its messages for the provider. If a prefix is still too large while existing tree merges are running, admission waits within the configured deadline. A summary failure, stalled prefix or expired deadline stops the request. Slow compression in one session does not block another session.

After the view and active tool loop are ready, the adapter checks their serialized UTF-8 bytes, observed system text and tool definitions against the current model's context/input limit and effective output allocation. `contextReserveBytes` adds an allowance for unobserved overhead; its default is 16,384. The policy treats one observed byte as one estimated input-budget unit. A larger existing OpenCode `compaction.reserved` value is preserved and used as at least that much numerical reserve; that host setting is expressed in tokens.

This is conservative admission, not an exact tokenizer count. The public hooks do not expose the final enabled tools, provider serialization, matching tokenizer or changes made by later plugins. Put OptChat last in the plugin list and leave room for provider and MCP overhead. These measures cannot establish a universal no-overflow guarantee.

The pinned host awaits the [message transform before model conversion](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/session/prompt.ts#L1255-L1286). Its [parameter hook runs before final tool preparation](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/session/llm/request.ts#L114-L175), and the [public hook signatures](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/plugin/src/index.ts#L247-L334) supply no final request or tokenizer. Those boundaries are why the adapter reports observed bytes and refuses known excess instead of claiming an exact token bound.

The adapter waits, then refuses input that still exceeds this policy. It does not drop a tool call/result pair or automatically retarget the tree to every smaller model window. Choose a smaller `viewBytes`, reduce the active turn's text/tool output, or select a larger model when the error reports insufficient headroom. A smaller reserve is an explicit capacity-policy choice, not evidence that a provider will accept the request. Unknown or invalid model limits are rejected.

The same capacity check applies to compressor children, whose output allocation is capped. Unmeasured background requests cannot reuse a conversation's admission snapshot. OpenCode's automatic title generation may therefore be unavailable; a manually titled session remains usable.

## Options

| Option | Purpose |
| --- | --- |
| `directory` | Required absolute Linux root for session stores. |
| `enabled` | Set to `false` for ordinary OpenCode behavior. |
| `model` | Optional configured OpenCode provider/model for compression. |
| `nodeBytes` | Maximum byte budget for a tree node. |
| `viewBytes` | Maximum rendered historical view bytes, including its `<chat>` envelope. |
| `compressionTimeoutMs` | Deadline for compressor calls and admission work. |
| `contextReserveBytes` | Conservative allowance for request overhead absent from public hooks; default 16,384, minimum 1,024. |

Keep default byte budgets until you have measured a reason to change them. An unusually small view budget can refuse inference when no already-built prefix fits it.

## Verify and update

Run `bun run typecheck`, `bun test tests`, and the two smoke tests described in [development verification](development/opencode-verification.md). The OpenCode smoke uses the actual pinned host against a local synthetic model with isolated configuration and no provider credentials.

Follow [upstream updates](development/upstream-updates.md) to bring changes from `ericjuta/omp-optchat` into this fork. Do not replace the upstream history with a copied source tree.

Upstream has no root license at the recorded baseline. This fork preserves existing notices and makes no new licensing claim. Vendored skill licenses apply to those vendored materials.
