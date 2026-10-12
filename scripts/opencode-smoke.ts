import assert from "node:assert/strict";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMessageInfo } from "@opencode/client";
import { bounded, Host, observed } from "./opencode-smoke-host.js";
import { archive, Fixture, longReply, memoryTools, protocol, waitForArchive } from "./opencode-smoke-fixture.js";
import { environment } from "./opencode-smoke-environment.js";
import { edgeCases } from "./opencode-smoke-scenarios.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function assertToolLoop(history: readonly SessionMessageInfo[]): void {
  const content = history.flatMap((message) => message.type === "assistant" ? message.content : []);
  for (const name of memoryTools) assert(content.some((part) => part.type === "tool" && part.name === name && part.state.status === "completed"),
    `real ${name} must complete`);
  assert(content.some((part) => part.type === "text" && part.text === protocol.complete), "host must persist the final public tool-loop response");
  assert(content.some((part) => part.type === "reasoning" && part.text === protocol.reasoning), "reasoning exclusion needs actual host reasoning input");
}

async function main(): Promise<void> {
  const executable = process.env.OPTCHAT_SMOKE_OPENCODE;
  assert(executable, "set OPTCHAT_SMOKE_OPENCODE to the reviewed OpenCode 2.0.27 executable");
  assert.equal(process.platform, "linux", "the shared durable store requires Linux or WSL");
  const fixture = new Fixture();
  const port = fixture.server.port;
  assert(port);
  const setup = await environment(ROOT, executable, port);
  const { memory, workspace, env, temporary } = setup;
  const hosts: Host[] = [];
  const start = () => {
    const host = new Host(executable, workspace, env);
    hosts.push(host);
    return host;
  };
  try {
    const versionProcess = Bun.spawn([executable, "--version"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const versionOutput = (await new Response(versionProcess.stdout).text()).trim();
    assert.equal(await versionProcess.exited, 0);
    assert.equal(versionOutput, "opencode v2.0.27", "reviewed native binary version must match the client SDK");
    const first = start();
    const client = await first.ready;
    const health = await client.server.info();
    assert.equal(health.version, "2.0.27");
    const session = (await first.create()).id;
    const slow = fixture.hold("compact");
    await first.prompt(session, protocol.first);
    const plugins = await client.plugin.list({ location: { directory: workspace } });
    assert(plugins.data.some((plugin) => plugin.id === "optchat" && plugin.state.status === "active"),
      `OptChat must load in the actual host: ${JSON.stringify(plugins.data)}`);
    const config = await client.config.get({ location: { directory: workspace } });
    assert(config.some((entry) => entry.type === "document" && entry.info.compaction?.auto === false));

    const initial = await waitForArchive(memory, longReply, session);
    const original = initial.records.find((record) => record.text === longReply);
    assert(original, "first raw reply must be durable before the next turn");
    fixture.targetID = original.i;
    await bounded(slow.started.promise, "held compactor arrival");
    const pending = observed(first.prompt(session, protocol.second));
    const independent = (await first.create("Independent while compressor waits")).id;
    await first.prompt(independent, protocol.first);
    const waiting = await first.history(session);
    assert(waiting.some((message) => message.type === "user" && message.text === protocol.second), "waiting turn must be canonical");
    assert.equal(fixture.mainCalls(session).length, 1, "held summaries must block the parent model");
    assert.equal(fixture.mainCalls(independent).length, 1, "independent session must finish while another compressor waits");
    slow.release.resolve();
    const completed = await pending;
    if (!completed.ok) throw completed.error;
    const history = await first.history(session);
    assertToolLoop(history);
    await waitForArchive(memory, protocol.complete, session);
    await first.stop();
    const beforeRestart = await archive(memory, session);
    const snapshots = new Map<string, string>();
    for (const entry of await readdir(memory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name === "view.json") snapshots.set(join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), "utf8"));
    }
    assert(snapshots.size > 0, "durable binary-tree view must exist");

    const second = start();
    assert.deepEqual(await second.history(session), history, "closed canonical history must survive process restart exactly");
    for (const [path, data] of snapshots) assert.equal(await readFile(path, "utf8"), data, "opening must preserve persisted views");
    await second.prompt(session, protocol.restart);
    await waitForArchive(memory, protocol.restored, session);
    const restored = await archive(memory, session);
    assert(restored.mergedNodes > 0, "bounded history must build binary merge nodes");
    for (const marker of [protocol.first, longReply, protocol.second, protocol.complete, protocol.restart, protocol.restored])
      assert.equal(restored.records.filter((record) => record.text === marker).length, 1, `exactly-once durable marker: ${marker.slice(0, 40)}`);
    assert.equal(new Set(restored.records.map((record) => record.i)).size, restored.records.length, "replay must not duplicate IDs");
    assert.deepEqual(restored.records.slice(0, beforeRestart.records.length), beforeRestart.records, "restart must preserve the durable prefix");
    const edges = await edgeCases({ second, start, fixture, memory });
    assert.deepEqual(fixture.errors, []);
    const compact = fixture.requests.filter((request) => request.model === "compact");
    assert(compact.length > 0, "compression must use the real host's stateless generation API");
    const main = fixture.requests.filter((request) => ["chat", "near"].includes(request.model));
    assert(main.every((request) => request.systemBytes > 0 && request.toolBytes > 2), "capacity evidence must include observed system and tool bytes");
    console.log(JSON.stringify({ ok: true, evidence: "loopback-model/real-opencode2-host", hostVersion: health.version, versionOutput,
      processes: hosts.length, chatRequests: main.length, compactorRequests: compact.length,
      durableRecords: restored.records.length, mergedNodes: restored.mergedNodes, rawBytes: Buffer.byteLength(longReply),
      slowCompression: { parentChatRequestsWhileHeld: 1, independentSessionCompleted: true },
      observedRequestBytes: main.map(({ inputBytes, systemBytes, toolBytes, max_tokens }) => ({ inputBytes, systemBytes, toolBytes, max_tokens })),
      ...edges, hostCompaction: { auto: false },
      checks: ["isolated project-only native configuration", "native background title", "four real memory tools", "raw original retrieval", "binary summary tree",
        "active tool calls and results", "reasoning excluded", "closed process restart", "exactly-once durable replay",
        "held compressor backpressure", "independent concurrent session", "failed compressor blocks raw fallback",
        "capacity refusal", "cancellation and same-session recovery", "active tool-loop crash restart"],
    }, null, 2));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack, fixtureErrors: fixture.errors,
      requests: fixture.requests.map(({ model, sessionID }) => ({ model, sessionID })),
      records: (await archive(memory)).records.map((record) => ({ id: record.i, kind: record.kind, text: record.text.slice(0, 80) })),
      hostDiagnostics: hosts.map((host) => host.diagnostics) }, null, 2));
    process.exitCode = 1;
  } finally {
    fixture.releaseAll();
    const stopped = await Promise.allSettled(hosts.map((host) => host.stop()));
    fixture.server.stop(true);
    await rm(temporary, { recursive: true, force: true });
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  }
}

if (import.meta.main) await main();
