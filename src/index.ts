/**
 * pi-fold-compact: a Pi compaction backend built from pi-fold (MIT, Shane Conner).
 *
 * Pi and other extensions still decide when to compact and where to cut. When a compaction runs,
 * the history before Pi's cut point is folded with pi-fold's own span selection, deterministic briefs
 * and consolidation, and no model is called. Before each model call the compaction summary is replaced
 * by pi-fold's per-fold placeholders, and the `pi_fold_context` tool reads folded spans back exactly.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activeContextStatus,
	boundStatusPayload,
	foldTreeDetail,
	peekFoldSource,
	setFoldProjectionState,
} from "./vendor/pi-fold/lib/folding.ts";
import { boundedInteger, toolPayload } from "./vendor/pi-fold/lib/measurement.ts";
import {
	ACTIVE_CONTEXT_POLICY,
	type ActiveContextSnapshot,
	type ActiveContextState,
	DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
	PEEK_DEFAULT_MAX_BYTES,
	PEEK_MIN_SLICE_BYTES,
} from "./vendor/pi-fold/lib/policy.ts";
import { buildActiveContextTool } from "./vendor/pi-fold/lib/tool-surface.ts";
import {
	DETAILS_KEY,
	EXPANSION_ENTRY,
	type Expansion,
	expansionFor,
	foldDetails,
	foldForCompaction,
	foldedRange,
	latestCompaction,
	projectFolded,
	stateFor,
	TOOL_NAME,
	withdrawConsumedPeeks,
} from "./fold.ts";

const ACTIONS = ["status", "peek", "expand", "refold"] as const;
const STATUS_DETAILS = ["tree", "folds", "objects"] as const;
const EPHEMERAL_NOTE =
	"this result rides your context exactly until your next message; " +
	"extract what your current task needs into that reply, which takes over its " +
	"place. Peeking again is lossless and cheap; pass ephemeral false when you " +
	"need these bytes standing for several turns";

interface View {
	key: string;
	compactionId: string;
	snapshot: ActiveContextSnapshot;
	state: ActiveContextState;
	/** The folded history as the model sees it, in place of Pi's compaction summary. */
	projected: unknown[];
}

export default function piFoldCompact(pi: ExtensionAPI): void {
	let cached: View | undefined;

	/** The latest folding compaction on the current branch, projected once per compaction and expansion state. */
	function viewOf(ctx: ExtensionContext): View | undefined {
		const branch = ctx.sessionManager.getBranch();
		const compaction = latestCompaction(branch);
		const details = foldDetails(compaction);
		if (!compaction || !details) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const expanded = expansionFor(branch, compaction.id);
		const key = JSON.stringify([sessionId, compaction.id, expanded]);
		if (cached?.key !== key) {
			const range = foldedRange({
				branch,
				coverageStartId: details.coverageStartId,
				base: details.base,
				firstKeptEntryId: compaction.firstKeptEntryId,
				endId: compaction.id,
				sessionId,
			});
			const state = stateFor(details, sessionId, expanded);
			cached = { key, compactionId: compaction.id, snapshot: range.snapshot, state, projected: projectFolded(range, state) };
		}
		return cached;
	}

	pi.on("session_before_compact", async (event, ctx) => {
		const { firstKeptEntryId, tokensBefore } = event.preparation;
		const { details, summary } = await foldForCompaction({
			branch: event.branchEntries,
			firstKeptEntryId,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { [DETAILS_KEY]: details } } };
	});

	pi.on("context", (event, ctx) => {
		if (event.messages[0]?.role !== "compactionSummary") return undefined;
		const view = viewOf(ctx);
		if (!view) return undefined;
		const messages = [...view.projected, ...event.messages.slice(1)];
		withdrawConsumedPeeks(messages);
		return { messages: messages as typeof event.messages };
	});

	async function execute(params: Record<string, unknown>, ctx: ExtensionContext) {
		const action = String(params.action ?? "");
		if (!(ACTIONS as readonly string[]).includes(action)) {
			throw new Error(`${TOOL_NAME} action '${action}' is not enabled in this runtime`);
		}
		const view = viewOf(ctx);
		if (!view) throw new Error("Nothing is folded on this branch yet; folds appear after the next compaction");
		const { snapshot, state } = view;

		if (action === "status") {
			const detail = params.detail;
			if (detail !== undefined && !(STATUS_DETAILS as readonly unknown[]).includes(detail)) {
				throw new Error(`status detail must be one of ${STATUS_DETAILS.map((name) => `'${name}'`).join(", ")}`);
			}
			const offset = boundedInteger(params.offset, 0, 0, 1_000_000, "offset");
			const limit = boundedInteger(params.limit, 40, 1, 100, "limit");
			const paged = detail === "folds" || detail === "objects";
			// Marks, re-cuts, briefs and pins belong to pi-fold's own runtime; only reads and expansion exist here.
			const { eligibleChapter: _chapter, currentTurnRequiresBoundary: _boundary, ...status } = activeContextStatus(
				snapshot,
				state,
				offset,
				limit,
				{ diet: !paged },
			);
			return toolPayload(
				boundStatusPayload(
					{
						...status,
						available: true,
						actions: {
							status: { action: "status", offset, limit },
							peek: { action: "peek", id: "<fold-id>" },
							expand: { action: "expand", id: "<fold-id>" },
							refold: { action: "refold", id: "<fold-id>" },
						},
						...(detail === "tree" ? { tree: foldTreeDetail(snapshot, state).slice(offset) } : {}),
					},
					typeof detail === "string" ? detail : null,
					offset,
				),
			);
		}

		const id = String(params.id ?? "").trim();
		if (!id) throw new Error(`${action} requires id`);

		if (action === "peek") {
			if (params.ephemeral !== undefined && typeof params.ephemeral !== "boolean") {
				throw new Error("peek ephemeral must be a boolean");
			}
			const offset = boundedInteger(params.offset, 0, 0, 1_000_000_000, "offset");
			const bytes = boundedInteger(params.bytes, PEEK_DEFAULT_MAX_BYTES, PEEK_MIN_SLICE_BYTES, ACTIVE_CONTEXT_POLICY.maxSourceChars, "bytes");
			return toolPayload({
				...peekFoldSource({
					foldId: id,
					state,
					entries: ctx.sessionManager.getEntries() as unknown as Array<Record<string, unknown>>,
					sessionId: ctx.sessionManager.getSessionId(),
					maximumBytes: bytes,
					offset,
					toolName: TOOL_NAME,
				}),
				...(params.ephemeral === false
					? { durable: "this result stays in your context like any other tool result" }
					: { ephemeral: EPHEMERAL_NOTE }),
			});
		}

		const fold = state.folds.find((item) => item.id === id);
		if (action === "expand" && fold && fold.kind !== "consolidation" && fold.sourceChars > ACTIVE_CONTEXT_POLICY.maxSourceChars) {
			throw new Error(
				`Fold ${id} holds ${fold.sourceChars} bytes, more than one read may restore (${ACTIVE_CONTEXT_POLICY.maxSourceChars}); peek it with offset and bytes instead`,
			);
		}
		const next = setFoldProjectionState(state, id, action === "expand" ? "expanded" : "folded");
		pi.appendEntry<Expansion>(EXPANSION_ENTRY, { compactionId: view.compactionId, expanded: next.expanded });
		return toolPayload({
			version: 1,
			action,
			id,
			state: action === "expand" ? "expanded" : "folded",
			activation: "durable immediately; projected on the next model call in this same turn",
		});
	}

	pi.registerTool(withoutCuration(
		buildActiveContextTool({
			name: TOOL_NAME,
			label: DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
			allowedActions: ACTIONS,
			fullSurface: false,
			maxBriefChars: ACTIVE_CONTEXT_POLICY.agentBriefReserve,
			statusDetails: STATUS_DETAILS,
			minPeekSliceBytes: PEEK_MIN_SLICE_BYTES,
			defaultPeekBytes: PEEK_DEFAULT_MAX_BYTES,
			handler: (_toolCallId, params, _signal, _onUpdate, ctx) => execute(params, ctx),
		}),
	) as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
}

/**
 * pi-fold's surface always carries the parameters of its curation actions: `brief` for agent-written
 * briefs on pending folds and `ids` for pins and re-cuts. Folds here are written whole at compaction
 * and only read back, so those parameters would only invite calls that cannot succeed.
 */
function withoutCuration<T extends { description: string; parameters: { properties: Record<string, unknown> } }>(tool: T): T {
	const { brief: _brief, ids: _ids, ...properties } = tool.parameters.properties;
	const description = tool.description.replace(/ Supplied fold briefs have a hard \d+-character maximum\.$/, "");
	if (description === tool.description) throw new Error("pi-fold's tool description changed; update withoutCuration");
	return { ...tool, description, parameters: { ...tool.parameters, properties } };
}
