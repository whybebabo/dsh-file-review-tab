/** Host-side, workspace-contained undo / redo service for produced text diffs. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { AnchorRequest, AnchorResult, FileReviewAction, FileReviewChange, FileReviewRequest, FileReviewResult, RecordedAnchor, RecordedMutation, RecordedRequest, RecordedResult } from './change-types.ts';
/** Apply a complete file's hunk sequence in memory, or report a strict mismatch. */
export declare function transformFile(text: string, file: FileReviewChange, action: FileReviewAction): string | null;
/** Host service published as the `fileReview` Remote namespace. */
export declare class FileReviewService extends TypertRemoteService {
    /** Per-agent record of Code Mode (`run_code`) file mutations, dispatch order. */
    private readonly recordLog;
    /**
     * Per-agent map of call id to the hunk coordinates that call applied.
     *
     * Keyed by call id alone: a mutation call writes one path, so the id already
     * names the settlement the anchors belong to. Re-recording an id replaces its
     * entry (a replay never duplicates), and insertion order is what the cap
     * evicts by.
     */
    private readonly anchorLog;
    constructor(ctx: Context);
    /** Append one nested (Code Mode) file mutation for the receiving agent. */
    recordMutation(agent: Agent, mutation: RecordedMutation): void;
    /**
     * Record one mutation's hunk coordinates, model-direct calls included.
     *
     * Called from `tools/post-execute` for every settled file mutation — that hook
     * is the last place the full before/after text exists, and therefore the only
     * place a hunk's absolute line numbers can still be recovered once the engine
     * has trimmed it down to context fragments.
     * @param agent - the agent that ran the mutation.
     * @param entry - the call id, path and per-hunk coordinates.
     */
    recordAnchors(agent: Agent, entry: RecordedAnchor): void;
    /**
     * Coordinates for the requested mutation calls.
     *
     * A call the recorder never saw is simply absent from the response: the client
     * keeps numbering that hunk's fragment from 1, exactly as it would without this
     * channel, so a missing entry can only ever cost the improvement, never the
     * diff itself.
     */
    anchors(agent: Agent, request: AnchorRequest): Promise<AnchorResult>;
    /** Return the recorded mutations for the requested `run_code` roots. */
    recorded(agent: Agent, request: RecordedRequest): Promise<RecordedResult>;
    /** Inspect current disk state without changing files. */
    status(agent: Agent, request: FileReviewRequest): Promise<FileReviewResult>;
    /** Toggle every independently safe file while the receiving Agent is idle. */
    apply(agent: Agent, request: FileReviewRequest): Promise<FileReviewResult>;
}
//# sourceMappingURL=file-review-service.d.ts.map