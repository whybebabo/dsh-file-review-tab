/**
 * File-review-tab plugin, node half. Records every settled file mutation's full
 * before/after text so the browser half can review Code Mode (`run_code`)
 * dispatches, and stamps each mutation call with the hunk coordinates that let
 * both review surfaces number a change by the file's real lines. The browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 *
 * This half deliberately registers NO system-prompt section: the Web
 * composition already owns the file-reference guidance
 * (`ui:deliverable-file-references`, contributed by
 * dsh-deliverable-file-references), and the older section this plugin used to
 * add contradicted it in every request. The browser half's inline-code mention
 * resolver keeps working without guidance of its own — it only matches paths
 * the model already wrote, and the host's prompt is what tells it how.
 */
import type { Context } from '@deepseek-ai/cordis';
export type * from './change-types.ts';
export { FileReviewService, transformFile } from './file-review-service.ts';
/** No host services are required: the recorder only listens to the tool waterfall. */
export declare const inject: string[];
/**
 * Record every settled file mutation for the browser-side review surfaces.
 *
 * Nested dispatch results carry no wire views — the diff cards only ride
 * model-direct tool/call frames — so reviewing programmatic file edits needs a
 * second source: this listener snapshots the full `before`/`after` content of
 * every nested file mutation (`edit`/`write` — recognized by result shape, not
 * tool name) into the `fileReview` service, which the browser half later turns
 * into line-level hunks and merges into the owning `run_code` turn.
 * @param ctx - host context carrying the tool waterfall.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map