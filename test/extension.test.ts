import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import piFoldCompact from "../src/index.ts";
import { DETAILS_KEY, type FoldDetails, rebind } from "../src/fold.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let clock = 1;

function user(sm: SessionManager, text: string) {
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
}

function work(sm: SessionManager, steps: number, tag: string, finish = true) {
	for (let i = 0; i < steps; i++) {
		const id = `${tag}-${i}`;
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Checked ${id}.` }, { type: "toolCall", id, name: "bash", arguments: { command: `run ${id}` } }],
			api: "anthropic-messages",
			provider: "test",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: clock++,
		});
		sm.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: `result ${id}\n${"x".repeat(3_000)}` }],
			isError: false,
			timestamp: clock++,
		});
	}
	if (finish) sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `Finished ${tag}.` }], api: "anthropic-messages", provider: "test", model: "test", usage, stopReason: "stop", timestamp: clock++ });
}

function harness() {
	const sm = SessionManager.inMemory("/tmp");
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let tool: any;
	piFoldCompact({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (definition: any) => {
			tool = definition;
		},
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
	} as never);
	const ctx = { sessionManager: sm };
	const compact = async () => {
		const preparation = prepareCompaction(sm.getBranch(), { enabled: true, reserveTokens: 16_384, keepRecentTokens: 2_000 })!;
		const result = await handlers.get("session_before_compact")!({ preparation, branchEntries: sm.getBranch(), reason: "manual" }, ctx);
		const { summary, firstKeptEntryId, tokensBefore, details } = result.compaction;
		sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
		return result.compaction as { summary: string; firstKeptEntryId: string; details: Record<string, FoldDetails> };
	};
	const context = (): any[] => {
		const messages = sm.buildSessionContext().messages.filter((message: any) => message.role !== "system");
		return handlers.get("context")!({ type: "context", messages }, ctx)?.messages ?? messages;
	};
	const call = async (params: Record<string, unknown>) => JSON.parse((await tool.execute("call", params, undefined, undefined, ctx)).content[0].text);
	return { sm, compact, context, call, tool };
}

const folds = (messages: any[]) => messages.filter((message) => message.customType === "pi-fold-active-context-fold");
const roots = (details: FoldDetails) => details.state.folds.filter((fold) => fold.parentId === null);

describe("pi-fold-compact", () => {
	it("folds the history before Pi's cut into pi-fold placeholders without a model call", async () => {
		const h = harness();
		user(h.sm, "Refactor the parser.");
		work(h.sm, 12, "a");
		user(h.sm, "Now the lexer.");
		work(h.sm, 3, "b");
		const compaction = await h.compact();
		const state = compaction.details[DETAILS_KEY]!.state;
		expect(state.folds.length).toBeGreaterThan(0);
		expect(compaction.summary).toContain("[pi-fold active-context fold ");
		const kept = new Set(h.sm.getBranch().slice(h.sm.getBranch().findIndex((e) => e.id === compaction.firstKeptEntryId)).map((e) => e.id));
		for (const fold of state.folds) for (const part of fold.parts) if (part.kind === "raw") expect(kept.has(part.ref.entryId)).toBe(false);

		const messages = h.context();
		expect(messages.some((message) => message.role === "compactionSummary")).toBe(false);
		expect(folds(messages)[0].content).toMatch(/^\[pi-fold active-context fold fold_\w+\]\n[\s\S]*\nTopology: kind=\w+; parent=root;[\s\S]*\nExpand exactly: pi_fold_context \{"action":"expand","id":"fold_\w+"\}\nList\/page exactly: pi_fold_context \{"action":"status"\}$/);
		expect(folds(messages)).toHaveLength(roots(compaction.details[DETAILS_KEY]!).length);
		expect(messages.at(-1).content[0].text).toBe("Finished b.");
		expect(h.context()).toEqual(messages);
	});

	it("folds the finished part of a turn that Pi's cut splits", async () => {
		const h = harness();
		user(h.sm, "Port the whole module.");
		work(h.sm, 30, "a", false);
		const compaction = await h.compact();
		const details = compaction.details[DETAILS_KEY]!;
		expect(roots(details).length).toBeGreaterThan(0);
		const messages = h.context();
		expect(folds(messages)).toHaveLength(roots(details).length);
		expect(messages.at(-1).content[0].text).toMatch(/^result a-29/);
	});

	it("reads folds back exactly, expands them in place and withdraws answered ephemeral peeks", async () => {
		const h = harness();
		user(h.sm, "Refactor the parser.");
		work(h.sm, 12, "a");
		user(h.sm, "Now the lexer.");
		work(h.sm, 3, "b");
		await h.compact();
		expect(h.tool.description).toMatch(/^Use only the configured active-context actions: status, peek, expand, refold\./);
		expect(h.tool.description).not.toMatch(/brief[s]? (have|is written)|Supplied fold briefs/);
		expect(h.tool.parameters.properties).not.toHaveProperty("brief");

		const status = await h.call({ action: "status" });
		expect(status.roots.length).toBeGreaterThan(0);
		expect(Object.keys(status.actions)).toEqual(["status", "peek", "expand", "refold"]);
		const id = status.roots[0];

		const peek = await h.call({ action: "peek", id, bytes: 200_000 });
		expect(peek.source).toContain("result a-0");
		expect(peek.ephemeral).toMatch(/^this result rides your context/);

		const before = folds(h.context()).length;
		await h.call({ action: "expand", id });
		const expanded = h.context();
		expect(folds(expanded).some((message) => message.content.includes(`fold ${id}]`))).toBe(false);
		expect(expanded.some((message) => message.role === "toolResult" && message.content[0].text.startsWith("result a-0"))).toBe(true);
		await h.call({ action: "refold", id });
		expect(folds(h.context()).length).toBe(before);

		const peeked = [
			{ role: "toolResult", toolCallId: "p", toolName: "pi_fold_context", content: [{ type: "text", text: "bytes" }], details: { action: "peek", ephemeral: "x" }, isError: false, timestamp: 1 },
		];
		h.sm.appendMessage(peeked[0] as never);
		expect(h.context().at(-1).content[0].text).toBe("bytes");
		h.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic-messages", provider: "test", model: "test", usage, stopReason: "stop", timestamp: clock++ });
		expect(h.context().at(-2).content[0].text).toBe("Ephemeral peek consumed; the reply that followed it is the surviving trace.");
	});

	it("carries folds into the next compaction and keeps an earlier foreign summary first", async () => {
		const h = harness();
		user(h.sm, "Start.");
		work(h.sm, 2, "z");
		const first = h.sm.getBranch().at(-1)!.id;
		h.sm.appendCompaction("Earlier summary from another backend.", first, 1, undefined, false);
		user(h.sm, "Refactor the parser.");
		work(h.sm, 12, "a");
		user(h.sm, "Now the lexer.");
		work(h.sm, 3, "b");
		const one = await h.compact();
		expect(one.details[DETAILS_KEY]!.base?.summary).toBe("Earlier summary from another backend.");
		expect(h.context()[0].role).toBe("compactionSummary");

		user(h.sm, "Next the printer.");
		work(h.sm, 12, "c");
		user(h.sm, "And tests.");
		work(h.sm, 3, "d");
		const two = await h.compact();
		const ids = (compaction: typeof one) => new Set(compaction.details[DETAILS_KEY]!.state.folds.map((fold) => fold.id));
		for (const id of ids(one)) expect(ids(two).has(id)).toBe(true);
		expect(h.context()[0].summary).toBe("Earlier summary from another backend.");
		expect(h.context().some((message) => message.role === "toolResult" && message.content[0].text.startsWith("result a-0"))).toBe(false);
	});

	it("rebinds evidence to a forked session", () => {
		const state = {
			version: 1,
			sessionId: "old",
			revision: 1,
			folds: [{ id: "f", kind: "chapter", parentId: null, parts: [{ kind: "raw", ref: { sessionId: "old", entryId: "e", role: "user", sha256: "s" } }] }],
			expanded: [],
			protected: [],
			tokensSinceToolFold: 0,
			leases: {},
		} as never;
		const next = rebind(state, "new");
		expect(next.sessionId).toBe("new");
		expect((next.folds[0]!.parts[0] as any).ref.sessionId).toBe("new");
	});
});
