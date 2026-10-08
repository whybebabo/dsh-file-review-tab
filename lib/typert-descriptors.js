import { z } from "zod";
//#region src/typert-descriptors.ts
/** Strict Typert codecs shared by the Host and browser contribution artifacts. */
const PACKAGE_NAME = "dsh-file-review-tab";
/**
* dsh 0.2.0 replaced the strict codec's eager `schema` member with a lazy
* `create()` factory, so the process-realm schema is materialized on first
* boundary use instead of at contribution-load time. DSH's own generated
* codecs memoize one schema instance per codec behind that factory; these
* helpers keep the same shape for hand-written descriptors.
* @param build - creates the Zod schema on first call.
* @returns a memoized schema factory suitable for `codec.create`.
*/
function lazySchema(build) {
	let value;
	return () => value ??= build();
}
/** One strict codec over a lazily materialized Zod schema. */
function strictCodec(typeSymbol, build) {
	return {
		mode: "strict",
		typeSymbol,
		create: lazySchema(build)
	};
}
const diffSchema = z.object({
	path: z.string(),
	oldText: z.string().nullable(),
	newText: z.string(),
	oldStart: z.number().int().min(1).optional(),
	newStart: z.number().int().min(1).optional()
});
const requestSchema = z.object({
	action: z.enum(["undo", "redo"]),
	files: z.array(z.object({
		path: z.string(),
		diffs: z.array(diffSchema)
	}))
});
const resultSchema = z.object({ files: z.array(z.object({
	path: z.string(),
	state: z.enum([
		"applied",
		"undone",
		"conflict",
		"unsupported",
		"error"
	]),
	changed: z.boolean(),
	reason: z.string().optional()
})) });
const agentCodec = strictCodec("@deepseek-ai/dsh-session/types#SessionId", () => z.intersection(z.string(), z.unknown()));
const requestCodec = strictCodec(`${PACKAGE_NAME}#FileReviewRequest`, () => requestSchema);
const resultCodec = strictCodec(`${PACKAGE_NAME}#FileReviewResult`, () => resultSchema);
const recordedMutationSchema = z.object({
	rootCallId: z.string(),
	name: z.string(),
	path: z.string(),
	before: z.string().nullable(),
	after: z.string()
});
const recordedRequestSchema = z.object({ rootCallIds: z.array(z.string()) });
const recordedResultSchema = z.object({ mutations: z.array(recordedMutationSchema) });
const recordedRequestCodec = strictCodec(`${PACKAGE_NAME}#RecordedRequest`, () => recordedRequestSchema);
const recordedResultCodec = strictCodec(`${PACKAGE_NAME}#RecordedResult`, () => recordedResultSchema);
function descriptor(method) {
	return {
		id: `${PACKAGE_NAME}#fileReview/${method}`,
		service: "fileReview",
		namespace: "fileReview",
		method,
		invocation: { kind: "direct" },
		scope: {
			context: "agent",
			wire: "agentId"
		},
		parameters: [{
			name: "agent",
			wire: "agentId",
			source: "lookup",
			lookup: "agent",
			codec: agentCodec
		}, {
			name: "request",
			wire: "request",
			source: "json",
			codec: requestCodec
		}],
		result: resultCodec
	};
}
function recordedDescriptor() {
	return {
		id: `${PACKAGE_NAME}#fileReview/recorded`,
		service: "fileReview",
		namespace: "fileReview",
		method: "recorded",
		invocation: { kind: "direct" },
		scope: {
			context: "agent",
			wire: "agentId"
		},
		parameters: [{
			name: "agent",
			wire: "agentId",
			source: "lookup",
			lookup: "agent",
			codec: agentCodec
		}, {
			name: "request",
			wire: "request",
			source: "json",
			codec: recordedRequestCodec
		}],
		result: recordedResultCodec
	};
}
const FILE_REVIEW_INVOCATIONS = [
	descriptor("status"),
	descriptor("apply"),
	recordedDescriptor()
];
//#endregion
export { PACKAGE_NAME as n, FILE_REVIEW_INVOCATIONS as t };
