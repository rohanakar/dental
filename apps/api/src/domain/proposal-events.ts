import type { ProposalEvent } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { CaseRepository, ProposalEventRepository } from '../ports/repositories';
import { notFound } from './errors';

/** Data flywheel: proposals and what the user finally accepted. */
export class ProposalEventService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly events: ProposalEventRepository,
    private readonly newId: () => string,
  ) {}

  async record(ctx: AuthContext, event: ProposalEvent): Promise<{ id: string }> {
    const found = await this.cases.get(ctx.orgId, event.caseId);
    if (!found) throw notFound('Case');
    const id = this.newId();
    await this.events.insert({ id, orgId: ctx.orgId, createdBy: ctx.userId, event });
    return { id };
  }
}
