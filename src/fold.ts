/**
 * Folding as a compaction backend. Compaction folds the history before Pi's cut point with
 * pi-fold's own selection, briefs and placeholders, and the context projection shows the
 * folds exactly as pi-fold renders them.
 */
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type EvidenceRef, objectRefKey } from "./vendor/pi-fold/json.ts";
import { contentText, emptyActiveContextState, messageRole, sessionEntryMessages } from "./vendor/pi-fold/lib/canonical.ts";
import {
	commitPreparedFold,
	prepareFold,
	projectActiveContext,
	selectAutomaticStaleSpan,
} from "./vendor/pi-fold/lib/folding.ts";
import type { ActiveContextSnapshot, ActiveContextState, FoldPart } from "./vendor/pi-fold/lib/policy.ts";
import { mapActiveContext } from "./vendor/pi-fold/lib/transcript.ts";

export const TOOL_NAME = "pi_fold_context";
export const DETAILS_KEY = "piFoldCompact";
export const EXPANSION_ENTRY = "pi-fold-compact-expansion";

export interface FoldDetails {
	version: 1;
	/** First entry of the folded history; null when it starts at the session's beginning. */
	coverageStartId: string | null;
	/** Summary of an earlier compaction that this plugin did not write, shown before the folds. */
	base: { summary: string; tokensBefore: number; timestamp: number } | null;
	state: ActiveContextState;
}

export interface Expansion {
	compactionId: string;
	expanded: string[];
}

type Entry = SessionEntry & Record<string, unknown>;

export function foldDetails(entry: SessionEntry | undefined): FoldDetails | undefined {
	if (entry?.type !== "compaction") return undefined;
	const details = (entry.details as Record<string, unknown> | undefined)?.[DETAILS_KEY] as FoldDetails | undefined;
	return details?.version === 1 ? details : undefined;
}

export function latestCompaction(branch: readonly SessionEntry[]): CompactionEntry | undefined {
	return branch.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

/** Context messages of the entries from `startId` up to, not including, `endId`, without compaction summaries. */
function rangeEntries(branch: readonly SessionEntry[], startId: string | null, endId: string | null): Entry[] {
	const start = startId === null ? 0 : branch.findIndex((entry) => entry.id === startId);
	const end = endId === null ? branch.length : branch.findIndex((entry) => entry.id === endId);
	if (start < 0 || end < 0) throw new Error("Folded history is not on the current branch");
	return branch.slice(start, end).filter((entry) => entry.type !== "compaction") as Entry[];
}

/**
 * The range as Pi's context would hold it without this compaction. An earlier summary leads it, as it
 * leads Pi's own context, so a range that starts inside a turn still opens a chapter segment.
 */
function messagesOf(entries: readonly Entry[]): unknown[] {
	return entries.flatMap((entry) => sessionEntryMessages(entry)).filter((message) => messageRole(message) !== "system");
}

function snapshotOf(sessionId: string, entries: Entry[], base: FoldDetails["base"]): ActiveContextSnapshot {
	return mapActiveContext({
		sessionId,
		eventMessages: [...baseMessage(base), ...messagesOf(entries)],
		contextEntries: entries,
	});
}

/** Forked sessions carry the parent's evidence; refs follow the session that now owns the entries. */
export function rebind(state: ActiveContextState, sessionId: string): ActiveContextState {
	if (state.sessionId === sessionId) return state;
	const ref = (value: EvidenceRef): EvidenceRef => ({ ...value, sessionId });
	const part = (value: FoldPart): FoldPart => (value.kind === "raw" ? { kind: "raw", ref: ref(value.ref) } : value);
	return {
		...state,
		sessionId,
		folds: state.folds.map((fold) => ({ ...fold, parts: fold.parts.map(part) })),
		protected: state.protected.map(ref),
	};
}

/**
 * The history a compaction folds, as Pi's context held it when the compaction ran. It runs on past the
 * cut point to the compaction itself, so pi-fold judges maturity and freshness against the whole branch;
 * the kept tail is never folded and is dropped again after projection.
 */
export interface FoldedRange {
	snapshot: ActiveContextSnapshot;
	/** Number of trailing snapshot messages that Pi keeps verbatim after the compaction. */
	keptMessages: number;
}

export function foldedRange(input: {
	branch: readonly SessionEntry[];
	coverageStartId: string | null;
	base: FoldDetails["base"];
	firstKeptEntryId: string;
	/** The compaction entry; null while the compaction is still being prepared. */
	endId: string | null;
	sessionId: string;
}): FoldedRange {
	const entries = rangeEntries(input.branch, input.coverageStartId, input.endId);
	const cut = entries.findIndex((entry) => entry.id === input.firstKeptEntryId);
	if (cut < 0) throw new Error("Pi's cut point is not on the current branch");
	return { snapshot: snapshotOf(input.sessionId, entries, input.base), keptMessages: messagesOf(entries.slice(cut)).length };
}

/** The folded history as pi-fold projects it: fold placeholders, expanded spans and unfoldable leftovers. */
export function projectFolded(range: FoldedRange, state: ActiveContextState): unknown[] {
	const projected = projectActiveContext(range.snapshot, state);
	const end = projected.length - range.keptMessages;
	const kept = range.snapshot.messages.slice(range.snapshot.messages.length - range.keptMessages);
	if (end < 0 || kept.some((message, index) => projected[end + index] !== message)) {
		throw new Error("A fold reached past Pi's cut point");
	}
	return projected.slice(0, end);
}

/** Folds every eligible span before Pi's cut point and returns the details stored on the compaction. */
export async function foldForCompaction(input: {
	branch: readonly SessionEntry[];
	firstKeptEntryId: string;
	sessionId: string;
}): Promise<{ details: FoldDetails; summary: string }> {
	const { branch, sessionId } = input;
	const previous = latestCompaction(branch);
	const carried = foldDetails(previous);
	let coverageStartId: string | null = null;
	let base: FoldDetails["base"] = null;
	let state = emptyActiveContextState(sessionId);
	if (carried && previous) {
		coverageStartId = carried.coverageStartId;
		base = carried.base;
		state = { ...rebind(carried.state, sessionId), expanded: [] };
	} else if (previous) {
		coverageStartId = previous.firstKeptEntryId;
		base = { summary: previous.summary, tokensBefore: previous.tokensBefore, timestamp: Date.parse(previous.timestamp) };
	}

	const range = foldedRange({ branch, coverageStartId, base, firstKeptEntryId: input.firstKeptEntryId, endId: null, sessionId });
	const { snapshot } = range;
	const claimed = new Set(
		snapshot.mapped
			.slice(snapshot.mapped.length - range.keptMessages)
			.flatMap((item) => (item.ref ? [objectRefKey(item.ref)] : [])),
	);

	for (let generation = 0; generation <= snapshot.mapped.length * 2; generation++) {
		const candidate = selectAutomaticStaleSpan(snapshot, state, claimed);
		if (!candidate) break;
		const prepared = await prepareFold({ candidate, snapshot, state, generation });
		state = commitPreparedFold({ prepared, snapshot, state, generation });
	}

	const details: FoldDetails = { version: 1, coverageStartId, base, state };
	return { details, summary: summaryText(projectFolded(range, state), base) };
}

export function stateFor(details: FoldDetails, sessionId: string, expanded: readonly string[]): ActiveContextState {
	return { ...rebind(details.state, sessionId), expanded: [...expanded] };
}

function baseMessage(base: FoldDetails["base"]): unknown[] {
	return base ? [{ role: "compactionSummary", summary: base.summary, tokensBefore: base.tokensBefore, timestamp: base.timestamp }] : [];
}

/** Pi stores this text as the compaction summary; it is what a session shows without this extension. */
function summaryText(folded: readonly unknown[], base: FoldDetails["base"]): string {
	const parts = base ? [base.summary] : [];
	for (const message of folded) {
		const role = messageRole(message);
		if (role === "compactionSummary") continue;
		const text = contentText(message);
		parts.push(role === "custom" ? text : `[${role}]\n${text}`);
	}
	return parts.join("\n\n");
}

export function expansionFor(branch: readonly SessionEntry[], compactionId: string): string[] {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.id === compactionId) break;
		if (entry.type === "custom" && entry.customType === EXPANSION_ENTRY) {
			const data = entry.data as Expansion | undefined;
			if (data?.compactionId === compactionId) return data.expanded;
		}
	}
	return [];
}

/**
 * Replaces each answered ephemeral peek with pi-fold's one-line placeholder. Peeks are recognized from
 * their stored result, so the withdrawal survives /reload.
 */
export function withdrawConsumedPeeks(messages: unknown[]): void {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index] as Record<string, unknown>;
		if (message?.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = message.details as Record<string, unknown> | undefined;
		if (details?.action !== "peek" || typeof details.ephemeral !== "string") continue;
		if (!messages.slice(index + 1).some((later) => (later as { role?: unknown })?.role === "assistant")) continue;
		messages[index] = {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: [{ type: "text", text: "Ephemeral peek consumed; the reply that followed it is the surviving trace." }],
			isError: false,
			details: { projection: "ephemeral-peek-consumed" },
			timestamp: message.timestamp,
		};
	}
}
