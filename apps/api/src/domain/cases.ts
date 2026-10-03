import type { CaseSummary, CreateCaseRequest, UpdateCaseRequest } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { CaseRecord, CaseRepository } from '../ports/repositories';
import { notFound } from './errors';

export class CaseService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly newId: () => string,
  ) {}

  create(ctx: AuthContext, input: CreateCaseRequest): Promise<CaseRecord> {
    return this.cases.create({ id: this.newId(), orgId: ctx.orgId, createdBy: ctx.userId, setup: input.setup });
  }

  list(ctx: AuthContext): Promise<CaseSummary[]> {
    return this.cases.list(ctx.orgId, 200);
  }

  async get(ctx: AuthContext, caseId: string): Promise<CaseRecord> {
    const found = await this.cases.get(ctx.orgId, caseId);
    if (!found) throw notFound('Case');
    return found;
  }

  async update(ctx: AuthContext, caseId: string, patch: UpdateCaseRequest): Promise<CaseRecord> {
    const updated = await this.cases.update(ctx.orgId, caseId, patch);
    if (!updated) throw notFound('Case');
    return updated;
  }
}
