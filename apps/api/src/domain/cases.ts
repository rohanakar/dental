import { type CaseSetup, type CaseSummary, type CreateCaseRequest, type UpdateCaseRequest, validateBridges } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { CaseRecord, CaseRepository } from '../ports/repositories';
import { DomainError, notFound } from './errors';

/** Bridge rules apply to stored setups too: a client must not store a setup the editor would refuse. */
function assertValidBridges(setup: CaseSetup): void {
  const { errors } = validateBridges(setup);
  if (errors.length) throw new DomainError('validation_error', `Invalid bridge setup: ${errors.map((e) => e.message).join('; ')}`, errors);
}

export class CaseService {
  constructor(
    private readonly cases: CaseRepository,
    private readonly newId: () => string,
  ) {}

  create(ctx: AuthContext, input: CreateCaseRequest): Promise<CaseRecord> {
    assertValidBridges(input.setup);
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
    if (patch.setup) assertValidBridges(patch.setup);
    const updated = await this.cases.update(ctx.orgId, caseId, patch);
    if (!updated) throw notFound('Case');
    return updated;
  }
}
