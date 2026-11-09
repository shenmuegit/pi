import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const output = vi.hoisted(() => [] as string[]);

vi.mock("../../../src/core/output-guard.ts", () => ({
	writeRawStdout: (text: string) => output.push(text),
	waitForRawStdoutBackpressure: async () => {},
	flushRawStdout: async () => {},
}));

function createRuntime(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Runtime replacement is not used in this test");
		},
	);
}

// #11238: extension sendUserMessage returns before its prompt starts the agent run.
describe("print mode extension command completion (#11238)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		output.length = 0;
		vi.restoreAllMocks();
	});

	it.each(["text", "json"] as const)("finishes a command's turn before %s output and shutdown", async (mode) => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const turns: string[] = [];
		const lifecycle: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("sayhi", {
						handler: async () => {
							pi.sendUserMessage("Say hello");
						},
					});
					pi.on("turn_end", (event, ctx) => {
						const entry = ctx.sessionManager.getEntry(event.messageEntryId);
						if (entry?.type === "message") turns.push(event.messageEntryId);
					});
					pi.on("agent_settled", (_event, ctx) => {
						lifecycle.push(`settled:${ctx.isIdle()}`);
					});
					pi.on("session_shutdown", () => {
						lifecycle.push("shutdown");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Hello from the command")]);

		const exitCode = await runPrintMode(createRuntime(harness), { mode, initialMessage: "/sayhi" });

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain(
			mode === "text" ? "Hello from the command\n" : '"text":"Hello from the command"',
		);
		expect(turns).toHaveLength(1);
		expect(lifecycle).toEqual(["settled:true", "shutdown"]);
		expect(errors).not.toHaveBeenCalled();
		if (mode === "json") {
			const types = output.map((line) => (JSON.parse(line) as { type: string }).type);
			expect(types).toContain("turn_end");
			expect(types.at(-1)).toBe("agent_settled");
		}
	});

	it.each(["text", "json"] as const)("waits for an async command's input hooks before %s output", async (mode) => {
		const inputStarted = Promise.withResolvers<void>();
		const inputReleased = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("sayhi", {
						handler: async () => {
							await Promise.resolve();
							pi.sendUserMessage("Say hello");
						},
					});
					pi.on("input", async () => {
						inputStarted.resolve();
						await inputReleased.promise;
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Hello after input")]);
		const run = runPrintMode(createRuntime(harness), { mode, messages: ["/sayhi"] });
		await inputStarted.promise;
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			inputReleased.resolve();
		}
		const exitCode = await run;
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(exitCode).toBe(0);
		expect(output.join("")).toContain(mode === "text" ? "Hello after input\n" : '"text":"Hello after input"');
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	// #11238: abort during input preflight must not wait for the input handler itself.
	it.each(["idle", "streaming"] as const)(
		"allows an input handler to await compaction while %s",
		async (state) => {
			const responseStarted = Promise.withResolvers<void>();
			const responseReleased = Promise.withResolvers<void>();
			let compacted = false;
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event, ctx) => {
							if (event.text !== "Say hello") return;
							await new Promise<void>((resolve, reject) => {
								ctx.compact({
									onComplete: () => {
										compacted = true;
										resolve();
									},
									onError: reject,
								});
							});
							return { action: "continue" };
						});
						pi.on("session_before_compact", (event) => ({
							compaction: {
								summary: "Compacted before input",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			await harness.session.prompt("seed one");
			await harness.session.prompt("seed two");
			let running: Promise<void> | undefined;
			if (state === "streaming") {
				harness.appendResponses([
					async () => {
						responseStarted.resolve();
						await responseReleased.promise;
						return fauxAssistantMessage("interrupted");
					},
				]);
				running = harness.session.prompt("start");
				await responseStarted.promise;
			}
			harness.appendResponses([fauxAssistantMessage("Hello after compaction")]);

			const prompt = harness.session.prompt("Say hello", { streamingBehavior: "followUp" });
			const waiting = harness.session.waitForIdle().then(() => harness.session.getLastAssistantText());
			responseReleased.resolve();
			await Promise.all([running, prompt]);

			expect(compacted).toBe(true);
			expect(await waiting).toBe("Hello after compaction");
			expect(harness.session.getLastAssistantText()).toBe("Hello after compaction");
		},
		3000,
	);

	it("finishes each command before sending the next print message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("sayhi", { handler: async () => pi.sendUserMessage("Say hello") });
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Hello"), fauxAssistantMessage("Goodbye")]);

		const exitCode = await runPrintMode(createRuntime(harness), {
			mode: "text",
			initialMessage: "/sayhi",
			messages: ["Say goodbye"],
		});

		expect(exitCode).toBe(0);
		expect(output).toEqual(["Goodbye\n"]);
		expect(getUserTexts(harness)).toEqual(["Say hello", "Say goodbye"]);
		expect(getAssistantTexts(harness)).toEqual(["Hello", "Goodbye"]);
	});

	it.each(["error", "aborted"] as const)(
		"returns a non-zero exit code for a command's %s response",
		async (stopReason) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const harness = await createHarness({
				settings: { retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.registerCommand("sayhi", { handler: async () => pi.sendUserMessage("Say hello") });
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "Command response failed" })]);

			const exitCode = await runPrintMode(createRuntime(harness), { mode: "text", initialMessage: "/sayhi" });

			expect(exitCode).toBe(1);
			expect(errors).toHaveBeenCalledWith("Command response failed");
		},
	);

	it.each(["handled", "rejected"] as const)(
		"settles idle waiting after a prompt is %s during preflight",
		async (outcome) => {
			const inputStarted = Promise.withResolvers<void>();
			const inputReleased = Promise.withResolvers<void>();
			const harness = await createHarness({
				withConfiguredAuth: outcome !== "rejected",
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							inputStarted.resolve();
							await inputReleased.promise;
							return { action: outcome === "handled" ? "handled" : "continue" };
						});
					},
				],
			});
			harnesses.push(harness);
			const prompt = harness.session.prompt("Never sent").catch((error: unknown) => error);
			await inputStarted.promise;
			let idle = false;
			const waiting = harness.session.waitForIdle().then(() => {
				idle = true;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(idle).toBe(false);
			} finally {
				inputReleased.resolve();
				await waiting;
				await prompt;
			}
			expect(harness.session.isIdle).toBe(true);
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		},
	);
});
