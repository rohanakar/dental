import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CaseSetup, CaseSummary, DesignVersion } from '@dcad/shared';
import type {
  CaseRecord,
  CaseRepository,
  FileRecord,
  FileRepository,
  LlmUsageRepository,
  ProposalEventRepository,
  Repositories,
  VersionRepository,
} from '../../ports/repositories';
import type { Db } from './client';
import { caseFiles, cases, designVersions, llmUsage, proposalEvents } from './schema';

type CaseRow = typeof cases.$inferSelect;
type FileRow = typeof caseFiles.$inferSelect;
type VersionRow = typeof designVersions.$inferSelect;

const iso = (d: Date) => d.toISOString();

function toSummary(row: CaseRow): CaseSummary {
  return {
    id: row.id,
    patientRef: row.patientRef,
    teeth: row.teeth,
    status: row.status,
    currentVersion: row.currentVersion,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
const toCaseRecord = (row: CaseRow): CaseRecord => ({ ...toSummary(row), setup: row.setup });

function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    caseId: row.caseId,
    kind: row.kind,
    name: row.name,
    sha256: row.sha256,
    bytes: row.bytes,
    contentType: row.contentType,
    encoding: row.encoding,
    blobKey: row.blobKey,
    createdAt: iso(row.createdAt),
  };
}

function toVersion(row: VersionRow): DesignVersion {
  return {
    caseId: row.caseId,
    version: row.version,
    parentVersion: row.parentVersion,
    author: row.author,
    doc: row.doc,
    createdAt: iso(row.createdAt),
  };
}

const teethOf = (setup: CaseSetup) => setup.teeth.map((t) => t.fdi);

function caseRepository(db: Db): CaseRepository {
  return {
    async create({ id, orgId, createdBy, setup }) {
      const [row] = await db
        .insert(cases)
        .values({ id, orgId, createdBy, setup, patientRef: setup.patientRef, teeth: teethOf(setup) })
        .returning();
      return toCaseRecord(row!);
    },
    async list(orgId, limit) {
      const rows = await db.select().from(cases).where(eq(cases.orgId, orgId)).orderBy(desc(cases.updatedAt)).limit(limit);
      return rows.map(toSummary);
    },
    async get(orgId, caseId) {
      const [row] = await db
        .select()
        .from(cases)
        .where(and(eq(cases.orgId, orgId), eq(cases.id, caseId)));
      return row ? toCaseRecord(row) : null;
    },
    async update(orgId, caseId, patch) {
      const values: Partial<typeof cases.$inferInsert> = { updatedAt: new Date() };
      if (patch.status) values.status = patch.status;
      if (patch.setup) {
        values.setup = patch.setup;
        values.patientRef = patch.setup.patientRef;
        values.teeth = teethOf(patch.setup);
      }
      const [row] = await db
        .update(cases)
        .set(values)
        .where(and(eq(cases.orgId, orgId), eq(cases.id, caseId)))
        .returning();
      return row ? toCaseRecord(row) : null;
    },
  };
}

function fileRepository(db: Db): FileRepository {
  return {
    async insert(input) {
      const [row] = await db.insert(caseFiles).values(input).returning();
      return toFileRecord(row!);
    },
    async get(orgId, fileId) {
      const [row] = await db
        .select()
        .from(caseFiles)
        .where(and(eq(caseFiles.orgId, orgId), eq(caseFiles.id, fileId)));
      return row ? toFileRecord(row) : null;
    },
    async listForCase(orgId, caseId) {
      const rows = await db
        .select()
        .from(caseFiles)
        .where(and(eq(caseFiles.orgId, orgId), eq(caseFiles.caseId, caseId)))
        .orderBy(caseFiles.createdAt);
      return rows.map(toFileRecord);
    },
  };
}

function versionRepository(db: Db): VersionRepository {
  return {
    async save({ orgId, caseId, parentVersion, author, doc, createdBy }) {
      return db.transaction(async (tx) => {
        // Compare-and-swap on cases.current_version.
        const [bumped] = await tx
          .update(cases)
          .set({ currentVersion: sql`${cases.currentVersion} + 1`, updatedAt: new Date() })
          .where(and(eq(cases.orgId, orgId), eq(cases.id, caseId), eq(cases.currentVersion, parentVersion)))
          .returning({ currentVersion: cases.currentVersion });
        if (!bumped) {
          const [existing] = await tx
            .select({ currentVersion: cases.currentVersion })
            .from(cases)
            .where(and(eq(cases.orgId, orgId), eq(cases.id, caseId)));
          return existing
            ? ({ ok: false, reason: 'conflict', currentVersion: existing.currentVersion } as const)
            : ({ ok: false, reason: 'not_found' } as const);
        }
        const [row] = await tx
          .insert(designVersions)
          .values({ caseId, orgId, version: bumped.currentVersion, parentVersion, author, doc, createdBy })
          .returning();
        return { ok: true, version: toVersion(row!) } as const;
      });
    },
    async latest(orgId, caseId) {
      const [row] = await db
        .select()
        .from(designVersions)
        .where(and(eq(designVersions.orgId, orgId), eq(designVersions.caseId, caseId)))
        .orderBy(desc(designVersions.version))
        .limit(1);
      return row ? toVersion(row) : null;
    },
  };
}

function proposalEventRepository(db: Db): ProposalEventRepository {
  return {
    async insert({ id, orgId, createdBy, event }) {
      await db.insert(proposalEvents).values({
        id,
        orgId,
        createdBy,
        caseId: event.caseId,
        fdi: event.fdi,
        step: event.step,
        proposerId: event.proposerId,
        action: event.action,
        event,
      });
    },
  };
}

function llmUsageRepository(db: Db): LlmUsageRepository {
  return {
    async insert(record) {
      await db.insert(llmUsage).values({ id: randomUUID(), ...record });
    },
  };
}

export function createRepositories(db: Db): Repositories {
  return {
    cases: caseRepository(db),
    files: fileRepository(db),
    versions: versionRepository(db),
    proposalEvents: proposalEventRepository(db),
    llmUsage: llmUsageRepository(db),
    health: {
      async ping() {
        await db.execute(sql`select 1`);
      },
    },
  };
}
