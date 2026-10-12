import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";
import { bounded, Host, observed, refused, SmokeFailure } from "./opencode-smoke-host.js";
import { archive, canonical, Fixture, longReply, memoryTools, protocol } from "./opencode-smoke-fixture.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const z = tool.schema;
async function waitForArchive(memory: string, marker: string, sessionID?: string) {
  const controller = new AbortController();
  const changes = watch(memory, { recursive: true, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const current = await archive(memory, sessionID);
      if (current.records.some((record) => record.text === marker)) return current;
      await changes.next();
    }
  } finally { controller.abort(); }
}

async function main(): Promise<void> {
  const executable = process.env.OPTCHAT_SMOKE_OPENCODE;
  assert(executable, "set OPTCHAT_SMOKE_OPENCODE to the reviewed OpenCode 1.19.0 executable");
  assert.equal(process.platform, "linux", "the shared durable store requires Linux or WSL");
  const temporary = await mkdtemp(join(tmpdir(), "optchat-opencode-smoke-"));
  const memory = join(temporary, "memory");
  const workspace = join(temporary, "workspace");
  const config = join(temporary, "config", "opencode");
  const home = join(temporary, "home");
  const fixture = new Fixture();
  const hosts: Host[] = [];
  try {
    await Promise.all([memory, workspace, config, home].map((path) => mkdir(path, { recursive: true })));
    const dependency = { "@opencode-ai/plugin": "1.19.0" };
    const pluginPackage = z.object({ version: z.literal("1.19.0") }).parse(JSON.parse(
      await readFile(join(ROOT, "node_modules/@opencode-ai/plugin/package.json"), "utf8")));
    await symlink(join(ROOT, "node_modules"), join(config, "node_modules"), "dir");
    await writeFile(join(config, "package.json"), JSON.stringify({ private: true, dependencies: dependency }));
    await writeFile(join(config, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: dependency } } }));
    const model = { name: "Loopback fixture", limit: { context: 128_000, output: 16_384 }, reasoning: true, tool_call: true };
    const configuration = {
      model: "fixture/chat", small_model: "fixture/compact", enabled_providers: ["fixture"],
      autoupdate: false, share: "disabled", compaction: { auto: true, prune: true, reserved: 2_048 },
      permission: { "*": "deny", ...Object.fromEntries(memoryTools.map((name) => [name, "allow"])) },
      plugin: [[pathToFileURL(join(ROOT, "src/opencode/index.ts")).href,
        { directory: memory, model: { providerID: "fixture", modelID: "compact" }, nodeBytes: 128, viewBytes: 384, compressionTimeoutMs: 20_000 }]],
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Loopback fixture",
        options: { baseURL: `http://127.0.0.1:${fixture.server.port}/v1`, apiKey: "synthetic-fixture-key" },
        models: { chat: model, compact: model, near: { ...model, limit: { context: 100_000, output: 4_096 } } } } },
    };
    const env: NodeJS.ProcessEnv = {
      PATH: `${dirname(executable)}:${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TZ: "UTC", TERM: "dumb", NO_COLOR: "1",
      HOME: home, TMPDIR: temporary, XDG_CONFIG_HOME: dirname(config), XDG_CACHE_HOME: join(temporary, "cache"),
      XDG_STATE_HOME: join(temporary, "state"), XDG_DATA_HOME: join(temporary, "data"), OPENCODE_TEST_HOME: home,
      OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration), OPENCODE_DB: join(temporary, "opencode.db"),
      OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost", npm_config_registry: "http://127.0.0.1:9", npm_config_offline: "true",
    };
    const first = new Host(executable, workspace, env);
    hosts.push(first);
    const health = z.object({ healthy: z.literal(true), version: z.literal("1.19.0") }).parse(await first.request("/global/health"));
    const ids = z.array(z.string()).parse(await first.request("/experimental/tool/ids"));
    for (const name of memoryTools) assert(ids.includes(name), `plugin did not register ${name}`);
    z.object({ compaction: z.object({ auto: z.literal(false), prune: z.literal(false), reserved: z.literal(2_048) }) })
      .parse(await first.request("/config"));
    const session = z.object({ id: z.string() }).parse(await first.request("/session", { title: "OptChat loopback smoke" })).id;

    await first.prompt(session, protocol.first);
    const initial = await waitForArchive(memory, longReply, session);
    const original = initial.records.find((record) => record.text === longReply);
    assert(original, "first raw reply must be durable before the next turn");
    fixture.targetID = original.i;
    const pending = first.prompt(session, protocol.second).then(() => ({ ok: true } as const), (error: unknown) => ({ ok: false, error } as const));
    await bounded(fixture.compactStarted.promise, "held compactor arrival");
    const independent = z.object({ id: z.string() }).parse(await first.request("/session", { title: "Independent while compressor waits" })).id;
    await first.prompt(independent, protocol.first);
    const waiting = canonical.parse(await first.request(`/session/${session}/message`));
    assert(waiting.some((message) => message.parts.some((part) => part.text === protocol.second)), "the waiting turn must be canonical");
    assert.equal(fixture.requests.filter((request) => request.model === "chat" && request.sessionID === session).length, 1,
      "the parent must not reach its model until the held compactor completes");
    assert.equal(fixture.requests.filter((request) => request.model === "chat" && request.sessionID === independent).length, 1,
      "an independent session must complete while the parent compressor waits");
    fixture.compactRelease.resolve();
    const completedTurn = await pending;
    if (!completedTurn.ok) throw completedTurn.error;
    const history = canonical.parse(await first.request(`/session/${session}/message`));
    const parts = history.flatMap((message) => message.parts);
    for (const name of memoryTools) assert(parts.some((part) => part.tool === name && part.state?.status === "completed"), `real ${name} must complete`);
    assert(parts.some((part) => part.type === "text" && part.text === protocol.complete), "host must persist the final public tool-loop response");
    assert(parts.some((part) => part.type === "reasoning" && part.text === protocol.reasoning), "reasoning exclusion needs actual host reasoning input");
    await first.dispose();
    await first.stop();
    const beforeRestart = await archive(memory, session);
    assert(beforeRestart.records.some((record) => record.text === protocol.complete),
      `final tool-loop reply must be durable: ${JSON.stringify({ records: beforeRestart.records.map((record) => ({ id: record.i, kind: record.kind, text: record.text.slice(0, 45) })),
        canonical: history.map((message) => ({ info: message.info, parts: message.parts.map((part) => ({ ...part, text: part.text?.slice(0, 45), state: part.state?.status })) })) })}`);
    const snapshots = new Map<string, string>();
    for (const entry of await readdir(memory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name === "view.json") snapshots.set(join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name), "utf8"));
    }
    assert(snapshots.size > 0, "a durable summary-tree view must exist");

    const second = new Host(executable, workspace, env);
    hosts.push(second);
    const restoredHistory = canonical.parse(await second.request(`/session/${session}/message`));
    assert.deepEqual(restoredHistory.map((message) => message.info.id), history.map((message) => message.info.id));
    for (const [path, data] of snapshots) assert.equal(await readFile(path, "utf8"), data, "opening a session must preserve its persisted view");
    await second.prompt(session, protocol.restart);
    await second.dispose();

    const restored = await archive(memory, session);
    assert(restored.mergedNodes > 0, "bounded history must build binary merge nodes");
    for (const marker of [protocol.first, longReply, protocol.second, protocol.complete, protocol.restart, protocol.restored]) {
      assert.equal(restored.records.filter((record) => record.text === marker).length, 1, `durable marker must occur exactly once: ${marker.slice(0, 40)}`);
    }
    assert.equal(new Set(restored.records.map((record) => record.i)).size, restored.records.length, "replay must not duplicate record IDs");
    const callsBeforeRefusal = fixture.requests.length;
    const manualCompaction: { readonly operation: string; readonly error: string }[] = [];
    for (const operation of [
      { name: "manualCompaction", run: () => second.request(`/session/${session}/summarize`, { providerID: "fixture", modelID: "compact" }) },
      { name: "subsequentPrompt", run: () => second.prompt(session, "OPTCHAT_FIXTURE_BLOCKED") },
    ]) {
      try {
        await operation.run();
        assert.fail(`${operation.name} must reject unsupported host compaction`);
      } catch (error) {
        if (!(error instanceof SmokeFailure)) throw error;
        manualCompaction.push({ operation: operation.name, error: error.message });
      }
    }
    assert.equal(fixture.requests.length, callsBeforeRefusal, "blocked compaction and continuation must not call any model");
    const fresh = z.object({ id: z.string() }).parse(await second.request("/session", { title: "OptChat fresh session after refusal" })).id;
    fixture.failureSession = fresh;
    await second.prompt(fresh, protocol.first);
    const freshHistory = canonical.parse(await second.request(`/session/${fresh}/message`));
    assert(freshHistory.some((message) => message.info.role === "assistant" && message.parts.some((part) => part.text === longReply)),
      "a fresh session must work after the unsupported compaction is refused");
    await waitForArchive(memory, longReply, fresh);
    let failedCompression: string | undefined;
    try {
      await second.prompt(fresh, protocol.second);
      assert.fail("failed compaction must block the next main-model request");
    } catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      failedCompression = error.message;
    }
    assert(fixture.forcedFailures > 0, "the failure scenario must actually call the synthetic compressor");
    assert.equal(fixture.requests.filter((request) => request.model === "chat" && request.sessionID === fresh).length, 1,
      "failed summaries must not fall back to sending raw history to the main model");
    const untitled = z.object({ id: z.string(), title: z.string() }).parse(await second.request("/session", {}));
    await second.prompt(untitled.id, protocol.first);
    assert.equal(fixture.requests.filter((request) => request.sessionID === untitled.id).length, 1, "untitled session must only call the main model");
    assert.equal(z.object({ title: z.string() }).parse(await second.request(`/session/${untitled.id}`)).title, untitled.title);
    const near = z.object({ id: z.string() }).parse(await second.request("/session", { title: "Capacity after settlement" })).id;
    await second.prompt(near, protocol.first);
    await waitForArchive(memory, longReply, near);
    const nearGate = fixture.hold("compact", near);
    const capacity = refused(second.prompt(near, `${protocol.second}\n${"capacity-payload ".repeat(768)}`, "near"), "near-capacity turn");
    await bounded(nearGate.started.promise, "near-capacity summary arrival");
    assert.equal(fixture.requests.filter((request) => request.sessionID === near).length, 1);
    nearGate.release.resolve();
    const capacityError = await capacity;
    assert.equal(fixture.requests.filter((request) => request.model === "near").length, 0, "oversized active payload must never reach a provider");
    const cancellation = z.object({ id: z.string() }).parse(await second.request("/session", { title: "Abort during summary" })).id;
    await second.prompt(cancellation, protocol.first);
    await waitForArchive(memory, longReply, cancellation);
    const cancelGate = fixture.hold("compact", cancellation);
    const cancelled = observed(second.prompt(cancellation, protocol.second));
    await bounded(cancelGate.started.promise, "cancelled summary arrival");
    const abortStarted = performance.now();
    await second.request(`/session/${cancellation}/abort`, {});
    const aborted = await bounded(cancelled, "parent abort while summary remains held", 5_000);
    assert(!aborted.ok && aborted.error instanceof SmokeFailure, "aborted prompt must report an assistant/HTTP error");
    const abortElapsedMs = Math.ceil(performance.now() - abortStarted);
    cancelGate.release.resolve();
    await second.prompt(cancellation, protocol.restart);
    assert.equal(fixture.requests.filter((request) => request.sessionID === cancellation).length, 2, "aborted parent must not make a later model call");
    const cancellationEvidence = { error: aborted.error.message, recovery: "same-session prompt completed", abortElapsedMs,
      recoveryElapsedMs: Math.ceil(performance.now() - abortStarted), abortedProviderCalls: 0 };
    const active = z.object({ id: z.string() }).parse(await second.request("/session", { title: "Restart active tool loop" })).id;
    await second.prompt(active, protocol.first);
    const activeArchive = await waitForArchive(memory, longReply, active);
    const activeRaw = activeArchive.records.find((record) => record.text === longReply);
    assert(activeRaw);
    fixture.targetID = activeRaw.i;
    const activeGate = fixture.hold("reply", active);
    const interrupted = observed(second.prompt(active, protocol.second));
    await bounded(activeGate.started.promise, "active tool-loop reply arrival");
    const activeHistory = canonical.parse(await second.request(`/session/${active}/message`));
    for (const name of memoryTools) assert(activeHistory.some((message) => message.parts.some((part) => part.tool === name && part.state?.status === "completed")));
    await second.stop();
    await bounded(interrupted, "interrupted client request", 5_000);
    activeGate.release.resolve();
    const third = new Host(executable, workspace, env);
    hosts.push(third);
    assert.deepEqual(canonical.parse(await third.request(`/session/${active}/message`)).map((message) => message.info.id), activeHistory.map((message) => message.info.id));
    const beforeInterruptedPrompt = await archive(memory, active);
    const activeCalls = fixture.requests.filter((request) => request.sessionID === active).length;
    const activeError = await refused(third.prompt(active, protocol.restart), "unfinished interrupted history");
    assert.equal(fixture.requests.filter((request) => request.sessionID === active).length, activeCalls, "unfinished history must reject before any parent provider call");
    const completedActive = canonical.parse(await third.request(`/session/${active}/message`));
    assert.deepEqual(completedActive.slice(0, activeHistory.length), activeHistory, "interrupted canonical history must remain intact");
    const replacement = z.object({ id: z.string() }).parse(await third.request("/session", { title: "Fresh session after interrupted history" })).id;
    await third.prompt(replacement, protocol.first);
    await third.dispose();
    await third.stop();
    const recovered = await archive(memory, active);
    assert.deepEqual(recovered.records, beforeInterruptedPrompt.records, "refused interrupted history must preserve the exact durable prefix");
    const cancelledArchive = await archive(memory, cancellation);
    for (const marker of [protocol.first, longReply, protocol.second, protocol.restart, protocol.restored])
      assert.equal(cancelledArchive.records.filter((record) => record.text === marker).length, 1, "cancelled-turn recovery must remain durable exactly once");
    assert.deepEqual(fixture.errors, []);
    const compact = fixture.requests.filter((request) => request.model === "compact");
    assert(compact.length > 0, "compression must pass through the real host SDK and loopback model");
    console.log(JSON.stringify({ ok: true, evidence: "loopback-model/real-opencode-host", hostVersion: health.version, pluginSDKVersion: pluginPackage.version,
      processes: hosts.length, chatRequests: fixture.requests.length - compact.length, compactorRequests: compact.length,
      durableRecords: restored.records.length, mergedNodes: restored.mergedNodes, rawBytes: Buffer.byteLength(longReply), manualCompaction,
      slowCompression: { parentChatRequestsWhileHeld: 1, independentSessionCompleted: true }, failedCompression, forcedFailures: fixture.forcedFailures,
      capacity: { context: 100_000, output: 4_096, reserveBytes: 16_384, providerCalls: 0, error: capacityError }, cancellation: cancellationEvidence,
      untitled: { mainCalls: 1, titleUnchanged: true }, activeLoopRestart: { canonicalMessages: activeHistory.length,
        durableRecords: recovered.records.length, error: activeError, interruptedProviderCalls: 0, freshSessionCompleted: true },
      hostCompaction: { auto: false, prune: false, retainedReserved: 2_048 },
      checks: ["fresh isolated configuration", "four real memory tools", "long reply durable before next turn", "compressed history with current raw suffix",
        "tool calls and public results", "canonical session after process restart", "persisted tree", "exactly-once replay", "reasoning excluded",
        "manual compaction rejects without model call", "affected session remains blocked", "fresh session recovers",
        "held compressor blocks parent model", "independent session progresses", "failed compressor prevents raw-history fallback",
        "capacity rejection after settlement", "untitled main admission survives title interleaving", "parent abort prevents provider call",
        "same-session recovery after abort", "interrupted incomplete history rejects and fresh session succeeds"],
    }, null, 2));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(JSON.stringify({ ok: false, error: error.message, fixtureErrors: fixture.errors, hostDiagnostics: hosts.map((host) => host.diagnostics) }, null, 2));
    process.exitCode = 1;
  } finally {
    const stopped = await Promise.allSettled(hosts.map((host) => host.stop()));
    fixture.server.stop(true);
    await rm(temporary, { recursive: true, force: true });
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  }
}

await main();
