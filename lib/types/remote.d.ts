/** Browser Typert contribution for the Host file-review service. */
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { AnchorRequest, AnchorResult, FileReviewRequest, FileReviewResult, RecordedRequest, RecordedResult } from './change-types.ts';
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap {
        fileReview: {
            status: (agentId: SessionId, request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
            apply: (agentId: SessionId, request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
            recorded: (agentId: SessionId, request: RecordedRequest) => Promise<RemoteResult<RecordedResult>>;
            anchors: (agentId: SessionId, request: AnchorRequest) => Promise<RemoteResult<AnchorResult>>;
        };
    }
    interface TypertRemoteMap {
        'fileReview/status': (agentId: SessionId, request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
        'fileReview/apply': (agentId: SessionId, request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
        'fileReview/recorded': (agentId: SessionId, request: RecordedRequest) => Promise<RemoteResult<RecordedResult>>;
        'fileReview/anchors': (agentId: SessionId, request: AnchorRequest) => Promise<RemoteResult<AnchorResult>>;
    }
    interface TypertRemoteScopeMap {
        'agent:fileReview/status': (request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
        'agent:fileReview/apply': (request: FileReviewRequest) => Promise<RemoteResult<FileReviewResult>>;
        'agent:fileReview/recorded': (request: RecordedRequest) => Promise<RemoteResult<RecordedResult>>;
        'agent:fileReview/anchors': (request: AnchorRequest) => Promise<RemoteResult<AnchorResult>>;
    }
}
export declare const TYPERT_REMOTE: TypertRemoteContribution;
export default TYPERT_REMOTE;
//# sourceMappingURL=remote.d.ts.map