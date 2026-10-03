import type { DesignVersion, SaveVersionRequest } from '@dcad/shared';
import type { AuthContext } from '../ports/auth';
import type { VersionRepository } from '../ports/repositories';
import { DomainError, notFound } from './errors';

export class VersionService {
  constructor(private readonly versions: VersionRepository) {}

  /** Optimistic concurrency: parentVersion must equal the case's current version. */
  async save(ctx: AuthContext, caseId: string, request: SaveVersionRequest): Promise<DesignVersion> {
    if (request.doc.caseId !== caseId) {
      throw new DomainError('validation_error', 'doc.caseId does not match the case in the URL');
    }
    const result = await this.versions.save({
      orgId: ctx.orgId,
      caseId,
      parentVersion: request.parentVersion,
      author: request.author,
      doc: request.doc,
      createdBy: ctx.userId,
    });
    if (result.ok) return result.version;
    if (result.reason === 'not_found') throw notFound('Case');
    throw new DomainError('conflict', 'Case was modified by someone else; reload and retry', {
      currentVersion: result.currentVersion,
    });
  }

  async latest(ctx: AuthContext, caseId: string): Promise<DesignVersion> {
    const version = await this.versions.latest(ctx.orgId, caseId);
    if (!version) throw notFound('Design version');
    return version;
  }
}
