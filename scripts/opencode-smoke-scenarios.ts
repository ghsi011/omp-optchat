import assert from "node:assert/strict";
import { Schema } from "effect";
import { bounded, eventually, Host, observed, refused, SmokeFailure } from "./opencode-smoke-host.js";
import { archive, Fixture, longReply, memoryTools, protocol, waitForArchive } from "./opencode-smoke-fixture.js";

type ScenarioInput = { readonly second: Host; readonly start: () => Host; readonly fixture: Fixture; readonly memory: string };
const capacityBudget = Schema.Struct({ messageBytes: Schema.Number, systemBytes: Schema.Number, toolBytes: Schema.Number,
  optionBytes: Schema.Number, reserveBytes: Schema.Number, inputBytes: Schema.Number, capacity: Schema.Number, output: Schema.Number });

export async function edgeCases({ second, start, fixture, memory }: ScenarioInput) {
  const nativeClient = await second.ready;
  const untitled = await nativeClient.session.create({ location: { directory: second.workspace }, model: { providerID: "fixture", id: "chat" } });
  await second.prompt(untitled.id, protocol.first);
  await eventually(async () => (await nativeClient.session.get({ sessionID: untitled.id })).title === protocol.title, "native background title");
  assert.equal(fixture.requests.filter((request) => request.model === "title" && request.sessionID === untitled.id).length, 1);

  const manual = (await second.create("Manual compaction refused")).id;
  await second.prompt(manual, protocol.first);
  const manualCalls = fixture.mainCalls(manual).length;
  const manualError = await refused(second.compact(manual), "native manual compaction");
  assert.equal(fixture.mainCalls(manual).length, manualCalls, "manual compaction must not call the session model");

  const failed = (await second.create("Failed compressor")).id;
  fixture.failCompression = true;
  await second.prompt(failed, protocol.first);
  await waitForArchive(memory, longReply, failed);
  const failureError = await refused(second.prompt(failed, protocol.second), "failed compressor continuation");
  assert(fixture.forcedFailures > 0, "failed scenario must reach the real generation request");
  assert.equal(fixture.mainCalls(failed).length, 1, "failed summary must prevent raw-history fallback");
  fixture.failCompression = false;

  const near = (await second.create("Capacity after settlement")).id;
  const capacityGate = fixture.hold("compact");
  await second.prompt(near, protocol.first);
  await waitForArchive(memory, longReply, near);
  await bounded(capacityGate.started.promise, "near-capacity summary arrival");
  const capacityText = `${protocol.second}\n${"capacity-payload ".repeat(2_048)}`;
  const capacity = observed(second.prompt(near, capacityText, "near"));
  assert.equal(fixture.mainCalls(near).length, 1);
  capacityGate.release.resolve();
  const capacityResult = await capacity;
  assert(!capacityResult.ok && capacityResult.error instanceof SmokeFailure, "oversized active request must fail closed");
  assert.equal(capacityResult.error.outcome, "failed");
  const encodedBudget = capacityResult.error.message.match(/\{[^{}]*"messageBytes"[^{}]*\}/)?.[0];
  assert(encodedBudget, `capacity refusal must report the measured request budget: ${capacityResult.error.message}`);
  const budget = Schema.decodeUnknownSync(capacityBudget)(JSON.parse(encodedBudget));
  assert.equal(budget.inputBytes, budget.messageBytes + budget.systemBytes + budget.toolBytes + budget.optionBytes + budget.reserveBytes);
  assert(budget.inputBytes > budget.capacity && budget.systemBytes > 0 && budget.toolBytes > 0 && budget.reserveBytes > 0);
  assert.equal(budget.capacity, 24_000 - budget.output);
  assert.equal(fixture.requests.filter((request) => request.model === "near").length, 0, "capacity refusal must precede provider dispatch");

  const cancellation = (await second.create("Cancel during summary")).id;
  const cancelGate = fixture.hold("compact");
  await second.prompt(cancellation, protocol.first);
  await waitForArchive(memory, longReply, cancellation);
  await bounded(cancelGate.started.promise, "cancelled summary arrival");
  const cancelled = observed(second.prompt(cancellation, protocol.second));
  const client = await second.ready;
  await eventually(async () => Boolean((await client.session.active())[cancellation]), "parent entered its blocked context hook");
  await second.interrupt(cancellation);
  const aborted = await bounded(cancelled, "parent interruption while generation remains held", 5_000);
  assert(!aborted.ok && aborted.error instanceof SmokeFailure, "interrupted turn must report a failed outcome");
  assert.equal(aborted.error.outcome, "interrupted");
  assert.equal(fixture.mainCalls(cancellation).length, 1, "cancelled parent must not reach the provider");
  cancelGate.release.resolve();
  await second.prompt(cancellation, protocol.restart);
  await waitForArchive(memory, protocol.restored, cancellation);
  assert.equal(fixture.mainCalls(cancellation).length, 2, "same-session recovery must make exactly one new main request");

  const active = (await second.create("Crash an active tool loop")).id;
  await second.prompt(active, protocol.first);
  const activeArchive = await waitForArchive(memory, longReply, active);
  const raw = activeArchive.records.find((record) => record.text === longReply);
  assert(raw);
  fixture.targetID = raw.i;
  const activeGate = fixture.hold("reply", active);
  const interrupted = observed(second.prompt(active, protocol.second));
  await bounded(activeGate.started.promise, "active tool-loop provider arrival");
  const activeHistory = await second.history(active);
  const tools = activeHistory.flatMap((message) => message.type === "assistant" ? message.content : []);
  for (const name of memoryTools) assert(tools.some((part) => part.type === "tool" && part.name === name && part.state.status === "completed"));
  const beforeCrash = await archive(memory, active);
  const activeCalls = fixture.mainCalls(active).length;
  await second.stop("SIGKILL");
  await bounded(interrupted, "crashed service client request", 5_000);
  activeGate.release.resolve();
  const third = start();
  await third.settle(active, activeHistory.length);
  const recoveredHistory = await third.history(active);
  assert.deepEqual(recoveredHistory.slice(0, activeHistory.length), activeHistory, "native restart must preserve its canonical prefix exactly");
  assert.equal(recoveredHistory.slice(activeHistory.length).filter((message) =>
    message.type === "synthetic" && message.text === protocol.recovery).length, 1, "native restart must retain exactly one recovery notice");
  assert.equal(fixture.mainCalls(active).length, activeCalls + 1, "resume must complete with exactly one main provider call");
  await waitForArchive(memory, protocol.complete, active);
  const recoveredTools = recoveredHistory.flatMap((message) => message.type === "assistant" ? message.content : []);
  for (const name of memoryTools) assert.equal(recoveredTools.filter((part) => part.type === "tool" && part.name === name).length, 1,
    "native recovery must not replay completed tools");
  await third.prompt(active, protocol.restart);
  await waitForArchive(memory, protocol.restored, active);
  assert.equal(fixture.mainCalls(active).length, activeCalls + 2, "the next user prompt must make exactly one additional provider call");
  const recoveredArchive = await archive(memory, active);
  for (const marker of [protocol.first, longReply, protocol.second, protocol.recovery, protocol.complete, protocol.restart, protocol.restored])
    assert.equal(recoveredArchive.records.filter((record) => record.text === marker).length, 1, "crash recovery must archive each public message exactly once");
  assert.equal(new Set(recoveredArchive.records.map((record) => JSON.stringify(record.metadata?.source))).size,
    recoveredArchive.records.length, "crash recovery must not duplicate source identities");
  assert.deepEqual((await archive(memory, active)).records.slice(0, beforeCrash.records.length), beforeCrash.records,
    "crash recovery must preserve the exact durable prefix");
  const fresh = (await third.create("Fresh session after crash recovery")).id;
  await third.prompt(fresh, protocol.first);
  assert.equal(fixture.mainCalls(fresh).length, 1);
  await third.stop();
  const cancelledArchive = await archive(memory, cancellation);
  for (const marker of [protocol.first, longReply, protocol.second, protocol.restart, protocol.restored])
    assert.equal(cancelledArchive.records.filter((record) => record.text === marker).length, 1, "cancelled recovery must remain durable exactly once");
  return {
    nativeTitle: { title: protocol.title, providerCalls: 1 },
    manualCompaction: { error: manualError, mainProviderCalls: 0 },
    failedCompression: { error: failureError, forcedFailures: fixture.forcedFailures, fallbackProviderCalls: 0 },
    capacity: { context: 24_000, activePayloadBytes: Buffer.byteLength(capacityText), providerCalls: 0, budget },
    cancellation: { error: aborted.error.message, recovery: "same-session prompt completed", abortedProviderCalls: 0 },
    activeLoopRestart: { canonicalMessages: activeHistory.length, durableRecords: beforeCrash.records.length,
      status: "recovered", providerCalls: 1, recoveryNotices: 1, replayedTools: 0,
      preservedCanonicalPrefix: true, preservedArchivePrefix: true, uniqueSourceIdentities: true, freshSessionCompleted: true },
  };
}
