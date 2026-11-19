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

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FileReviewService } from './file-review-service.ts'
import { hunkAnchors } from './hunk-anchors.ts'

export type * from './change-types.ts'
export { FileReviewService, transformFile } from './file-review-service.ts'

/** No host services are required: the recorder only listens to the tool waterfall. */
export const inject: string[] = []

/** Runtime shape of the `tools/post-execute` waterfall arguments we consume. */
interface PostExecuteCall {
  readonly name: string
  readonly callId: string
  readonly rootCallId?: string | undefined
  readonly parent?: unknown
  readonly agent?: Agent | undefined
}
interface PostExecuteResult {
  readonly value?: unknown
}
type PostExecuteDecision = { readonly kind: string }
type PostExecuteNext = () => Promise<PostExecuteDecision>

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
export function apply(ctx: Context): void {
  const service = new FileReviewService(ctx)

  // 'tools/post-execute' lives in the host tool registry's Cordis event map,
  // outside this package's typed Events surface; the loose emitter cast keeps
  // the runtime contract (args are unknown-typed below) without inventing a
  // dependency on the registry plugin's type package. ctx.effect owns the
  // registration so fiber disposal (HMR / plugin disable) removes the
  // listener — a leaked one would record every mutation twice.
  const emitter = ctx as unknown as {
    on(event: string, listener: (exec: unknown, result: unknown, next: unknown) => unknown): () => void
  }
  ctx.effect(() => {
    const off = emitter.on('tools/post-execute', async (
      execRaw: unknown,
      resultRaw: unknown,
      nextRaw: unknown,
    ): Promise<PostExecuteDecision> => {
      const exec = execRaw as PostExecuteCall
      const result = resultRaw as PostExecuteResult
      const next = nextRaw as PostExecuteNext
      const decision = await next()
      if (decision.kind !== 'accept') return decision
      if (exec.agent === undefined) return decision
      const value = result.value
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return decision
      const candidate = value as { path?: unknown; before?: unknown; after?: unknown }
      if (typeof candidate.path !== 'string' || typeof candidate.after !== 'string') return decision
      if (candidate.before !== null && typeof candidate.before !== 'string') return decision
      const before = candidate.before ?? null
      // EVERY mutation gets its hunk coordinates recorded, model-direct calls
      // included: the conversation snapshot the review surfaces read only ever
      // carries the engine's context fragments, which have no line numbers in
      // them, so this hook is the last point where a hunk's absolute lines still
      // exist. Recording it is what lets the tab and the chat preview number a
      // change by the file's real lines instead of a per-hunk counter.
      service.recordAnchors(exec.agent, {
        callId: String(exec.callId),
        path: candidate.path,
        anchors: hunkAnchors(before, candidate.after),
      })
      // Model-direct mutations are already reviewable through conversation views;
      // only nested dispatches (run_code sub-calls) also need the host-side
      // before/after snapshot that the Code Mode review path rebuilds its hunks
      // from.
      if (exec.parent === undefined) return decision
      service.recordMutation(exec.agent, {
        rootCallId: String(exec.rootCallId ?? exec.callId),
        name: exec.name,
        path: candidate.path,
        before,
        after: candidate.after,
      })
      return decision
    })
    return () => { off() }
  }, 'file-review-tab: ptc recorder')
}
