import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function outputRecords(): Record<string, unknown>[] {
	return rpcIo.outputLines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function promptResponses(id: string): Record<string, unknown>[] {
	return outputRecords().filter(
		(record) => record.type === "response" && record.id === id && record.command === "prompt",
	);
}

async function startRpc(harness: Harness) {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
	const signalListeners = signals.map((signal) => ({ signal, listeners: process.listeners(signal) }));
	const endListeners = process.stdin.listeners("end");
	const dispose = vi.fn(async () => {});
	// These commands exercise the real session; session replacement is outside this test's RPC boundary.
	const runtimeHost = {
		session: harness.session,
		setRebindSession: vi.fn(),
		dispose,
	} as unknown as AgentSessionRuntime;
	void runRpcMode(runtimeHost);
	const lineHandler = await vi.waitFor(() => {
		if (!rpcIo.lineHandler) throw new Error("RPC input was not attached");
		return rpcIo.lineHandler;
	});
	return {
		send: (command: RpcCommand) => lineHandler(JSON.stringify(command)),
		dispose,
		cleanup: () => {
			for (const { signal, listeners } of signalListeners) {
				for (const listener of process.listeners(signal)) {
					if (!listeners.includes(listener)) process.off(signal, listener);
				}
			}
			for (const listener of process.stdin.listeners("end") as Array<() => void>) {
				if (!endListeners.includes(listener)) process.stdin.off("end", listener);
			}
		},
	};
}

async function createSettledHarness(extensions: NonNullable<HarnessOptions["extensionFactories"]> = []) {
	const settled = deferred();
	const releaseSettlement = deferred();
	let firstSettlement = true;
	const harness = await createHarness({
		settings: { compaction: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", () => pi.sendUserMessage("BOOT"));
				pi.on("agent_settled", async () => {
					if (!firstSettlement) return;
					firstSettlement = false;
					settled.resolve();
					await releaseSettlement.promise;
				});
			},
			...extensions,
		],
	});
	harness.setResponses([fauxAssistantMessage("bootstrap complete"), fauxAssistantMessage("deferred answer")]);
	return { harness, settled, releaseSettlement };
}

async function createCompactingHarness(extensions: NonNullable<HarnessOptions["extensionFactories"]> = []) {
	const settled = deferred();
	const releaseSettlement = deferred();
	const compacting = deferred();
	const releaseCompaction = deferred();
	const compacted = deferred();
	let firstSettlement = true;
	const compactionErrors: Error[] = [];
	const harness = await createHarness({
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_settled", async (_event, ctx) => {
					if (!firstSettlement) return;
					firstSettlement = false;
					settled.resolve();
					await releaseSettlement.promise;
					ctx.compact({
						onComplete: () => compacted.resolve(),
						onError: (error) => {
							compactionErrors.push(error);
							compacted.resolve();
						},
					});
					await compacting.promise;
				});
				pi.on("session_before_compact", async (event) => {
					compacting.resolve();
					await releaseCompaction.promise;
					return {
						compaction: {
							summary: "bootstrap checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
			...extensions,
		],
	});
	harness.setResponses([fauxAssistantMessage("bootstrap complete")]);
	return {
		harness,
		settled,
		releaseSettlement,
		compacting,
		releaseCompaction,
		compacted,
		compactionErrors,
	};
}

describe("#12196: deferred RPC prompt results", () => {
	// #12196: a rejection before preflight belongs to the deferred caller, not the bootstrap run.
	it("rejects the original deferred prompt when settlement starts compaction", async () => {
		const { harness, settled, releaseSettlement, compacting, releaseCompaction, compacted, compactionErrors } =
			await createCompactingHarness();
		const bootstrap = harness.session.prompt("BOOT").then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);

		try {
			await settled.promise;
			const preflightResult = vi.fn();
			const prompt = harness.session.prompt("D", { source: "rpc", preflightResult }).then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);
			releaseSettlement.resolve();
			await compacting.promise;

			expect(await prompt).toEqual({
				status: "rejected",
				error: expect.objectContaining({ message: expect.stringContaining("compaction is in progress") }),
			});
			expect(await bootstrap).toEqual({ status: "fulfilled" });
			expect(preflightResult).not.toHaveBeenCalled();
			expect(getUserTexts(harness)).toEqual(["BOOT"]);
			expect(
				harness.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
					),
			).toEqual(["BOOT"]);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			releaseSettlement.resolve();
			releaseCompaction.resolve();
			await bootstrap;
			await compacted.promise;
			harness.cleanup();
		}
		expect(compactionErrors).toEqual([]);
	});

	// #12196: an earlier extension rejection must not discard the remaining settlement batch.
	it("processes a deferred RPC prompt after an extension prompt fails", async () => {
		const { harness, settled, releaseSettlement, compacting, releaseCompaction, compacted } =
			await createCompactingHarness([
				(pi) => {
					pi.registerCommand("handled", { handler: async () => {} });
				},
			]);
		const bootstrap = harness.session.prompt("BOOT").catch((error: unknown) => error);
		try {
			await settled.promise;
			await harness.session.sendUserMessage("extension continuation");
			const preflightResult = vi.fn();
			const prompt = harness.session.prompt("/handled", { source: "rpc", preflightResult });
			releaseSettlement.resolve();
			await compacting.promise;

			expect(await bootstrap).toEqual(
				expect.objectContaining({ message: expect.stringContaining("compaction is in progress") }),
			);
			expect(preflightResult).toHaveBeenCalledExactlyOnceWith("handled");
			await prompt;
			expect(getUserTexts(harness)).toEqual(["BOOT"]);
		} finally {
			releaseSettlement.resolve();
			releaseCompaction.resolve();
			await bootstrap;
			await compacted.promise;
			harness.cleanup();
		}
	});

	// #12196: every request in the same settlement batch must receive its own refusal response.
	it.each([
		{ label: "one request", ids: ["D"], clearQueue: false },
		{ label: "two requests", ids: ["D1", "D2"], clearQueue: false },
		{ label: "a request after clear_queue", ids: ["D"], clearQueue: true },
	])("emits one correlated failure for $label during bootstrap compaction", async ({ ids, clearQueue }) => {
		const { harness, settled, releaseSettlement, compacting, releaseCompaction, compacted } =
			await createCompactingHarness([
				(pi) => {
					pi.on("session_start", () => pi.sendUserMessage("BOOT"));
				},
			]);
		const rpc = await startRpc(harness);
		try {
			await settled.promise;
			for (const id of ids) rpc.send({ id, type: "prompt", message: id });
			if (clearQueue) {
				rpc.send({ id: "clear", type: "clear_queue" });
				await vi.waitFor(() =>
					expect(outputRecords()).toContainEqual({
						id: "clear",
						type: "response",
						command: "clear_queue",
						success: true,
						data: { steering: [], followUp: [] },
					}),
				);
			}
			for (const id of ids) expect(promptResponses(id)).toEqual([]);
			releaseSettlement.resolve();
			await compacting.promise;
			await vi.waitFor(() => {
				for (const id of ids) {
					expect(promptResponses(id)).toEqual([
						{
							id,
							type: "response",
							command: "prompt",
							success: false,
							error: expect.stringContaining("compaction is in progress"),
						},
					]);
				}
			});
			releaseCompaction.resolve();
			await compacted.promise;
			for (const id of ids) expect(promptResponses(id)).toHaveLength(1);
			expect(outputRecords().filter((record) => record.type === "extension_error")).toEqual([]);
			for (const id of ids) expect(getUserTexts(harness)).not.toContain(id);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			releaseSettlement.resolve();
			releaseCompaction.resolve();
			await compacted.promise;
			rpc.cleanup();
			harness.cleanup();
		}
	});

	// #12196: delayed admission still distinguishes started prompts from extension-handled input.
	it.each([
		{ message: "D", disposition: "started", calls: 2, settlements: 2 },
		{ message: "/handled", disposition: "handled", calls: 1, settlements: 1 },
		{ message: "handled input", disposition: "handled", calls: 1, settlements: 1 },
	])(
		"emits one $disposition response for deferred '$message'",
		async ({ message, disposition, calls, settlements }) => {
			const { harness, settled, releaseSettlement } = await createSettledHarness([
				(pi) => {
					pi.registerCommand("handled", { handler: async () => {} });
					pi.on("input", (event) => {
						if (event.text === "handled input") return { action: "handled" };
					});
				},
			]);
			const rpc = await startRpc(harness);
			try {
				await settled.promise;
				rpc.send({ id: "D", type: "prompt", message });
				expect(promptResponses("D")).toEqual([]);
				releaseSettlement.resolve();
				await vi.waitFor(() => {
					expect(promptResponses("D")).toEqual([
						{ id: "D", type: "response", command: "prompt", success: true, data: { disposition } },
					]);
					expect(harness.eventsOfType("agent_settled")).toHaveLength(settlements);
				});
				expect(harness.faux.state.callCount).toBe(calls);
				expect(getUserTexts(harness)).toEqual(disposition === "started" ? ["BOOT", "D"] : ["BOOT"]);
				expect(outputRecords().filter((record) => record.type === "extension_error")).toEqual([]);
			} finally {
				releaseSettlement.resolve();
				await harness.session.abort();
				rpc.cleanup();
				harness.cleanup();
			}
		},
	);

	// #12196: SDK calls awaited inside settled handlers must not wait on their own deferred work.
	it("lets an awaited SDK continuation leave its settled handler", async () => {
		let continued = false;
		const idleStates: boolean[] = [];
		const harness: Harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async (_event, ctx) => {
						if (continued) return;
						continued = true;
						idleStates.push(ctx.isIdle());
						await harness.session.sendUserMessage("continuation");
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		try {
			await harness.session.prompt("BOOT");
			expect(getUserTexts(harness)).toEqual(["BOOT", "continuation"]);
			expect(idleStates).toEqual([true]);
		} finally {
			harness.cleanup();
		}
	});

	// #12196: shutdown must wait for the deferred prompt's result, even while settlement reports idle.
	it("writes the deferred response before an extension-requested shutdown", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		let requestShutdown = () => {};
		const { harness, settled, releaseSettlement } = await createSettledHarness([
			(pi) => {
				pi.on("session_start", (_event, ctx) => {
					requestShutdown = () => ctx.shutdown();
				});
			},
		]);
		const rpc = await startRpc(harness);
		try {
			await settled.promise;
			rpc.send({ id: "D", type: "prompt", message: "D" });
			requestShutdown();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(rpc.dispose).not.toHaveBeenCalled();
			expect(promptResponses("D")).toEqual([]);
			releaseSettlement.resolve();
			await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
			expect(promptResponses("D")).toEqual([
				{ id: "D", type: "response", command: "prompt", success: true, data: { disposition: "started" } },
			]);
			expect(harness.session.getLastAssistantText()).toBe("deferred answer");
		} finally {
			releaseSettlement.resolve();
			await harness.session.abort();
			rpc.cleanup();
			harness.cleanup();
			vi.restoreAllMocks();
		}
	});

	// #12196: a run-stage rejection after acceptance must not add a second response for D.
	it("does not emit a second response when a deferred run later rejects", async () => {
		const { harness, settled, releaseSettlement } = await createSettledHarness();
		const lateFailure = deferred();
		let settlements = 0;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled" && ++settlements === 2) {
				lateFailure.resolve();
				throw new Error("late run failure");
			}
		});
		const rpc = await startRpc(harness);
		try {
			await settled.promise;
			rpc.send({ id: "D", type: "prompt", message: "D" });
			releaseSettlement.resolve();
			await lateFailure.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(promptResponses("D")).toEqual([
				{ id: "D", type: "response", command: "prompt", success: true, data: { disposition: "started" } },
			]);
		} finally {
			releaseSettlement.resolve();
			await harness.session.abort();
			rpc.cleanup();
			harness.cleanup();
		}
	});
});
