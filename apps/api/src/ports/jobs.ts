import type { ProposalJobRequest, ProposalJobStatus } from '@dcad/shared';

/**
 * Server-side proposer jobs (future ml.* proposers on a GPU host).
 * MVP adapter is inline and reports "not available".
 */
export interface JobQueue {
  readonly available: boolean;
  enqueue(orgId: string, request: ProposalJobRequest): Promise<ProposalJobStatus>;
  get(orgId: string, jobId: string): Promise<ProposalJobStatus | null>;
  cancel(orgId: string, jobId: string): Promise<void>;
}
