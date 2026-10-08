import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { FileReviewRequest, FileReviewResult } from '../change-types.ts';
import type { NS } from './chat-locales.ts';
/**
 * Turn-tail owner currency plus the opener and locale supplied by the slot.
 *
 * dsh 0.2.0's `conversation.chat.turnTail` is a `list` slot, so there is no
 * chain selector to receive a pre-matched value on: the component runs the
 * claim test itself ({@link selectProducedFiles}) and renders nothing when the
 * closing turn produced no files.
 */
export type ProducedFilesProps = TurnTailOwnerProps & {
    /** Session workspace root (reserved; the chat card shows tool paths verbatim). */
    projectRoot?: string | undefined;
    inspectChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>;
    applyChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>;
    /**
     * Open the plugin's sidebar tab with the given paths pre-expanded
     * (the 审查 button passes every produced path; a file chip passes its own).
     * The owning turn number rides along so the tab expands only this turn's
     * rows — a path that recurs in other turns stays collapsed there.
     */
    openInSidebarTab?: (paths: readonly string[], turn?: number) => void;
} & PropsLocale<typeof NS>;
/**
 * Turn-tail list entry: claim the turn, then render the card.
 *
 * The claim test lives here rather than in a chain selector because
 * `conversation.chat.turnTail` is an additive `list` in dsh 0.2.0. Splitting
 * the test from the card keeps the card's hook order unconditional: the
 * wrapper holds no hooks, so early-returning null for an unsettled turn can
 * never change how many hooks the card below it calls.
 * @param props - turn-tail owner currency plus the plugin's injected face.
 * @returns the produced-files card, or null when this turn produced no files.
 */
export declare function ProducedFiles(props: ProducedFilesProps): import("react").JSX.Element | null;
//# sourceMappingURL=ProducedFiles.d.ts.map