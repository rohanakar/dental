import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { CaseSetup, DesignDocument, ProposalEvent } from '@dcad/shared';
import { organization, user } from './auth-schema';

/** Application tables. Every row carries org_id; repositories always filter on it. */

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    patientRef: text('patient_ref').notNull(),
    teeth: jsonb('teeth').$type<number[]>().notNull(),
    setup: jsonb('setup').$type<CaseSetup>().notNull(),
    status: text('status').$type<'draft' | 'in-design' | 'done'>().notNull().default('draft'),
    currentVersion: integer('current_version').notNull().default(0),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('cases_org_updated_idx').on(t.orgId, t.updatedAt)],
);

export const caseFiles = pgTable(
  'case_files',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'upper' | 'lower' | 'preop' | 'export' | 'artifact'>().notNull(),
    name: text('name').notNull(),
    sha256: text('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    encoding: text('encoding').$type<'identity' | 'gzip'>().notNull(),
    blobKey: text('blob_key').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('case_files_org_case_idx').on(t.orgId, t.caseId), index('case_files_sha_idx').on(t.sha256)],
);

export const designVersions = pgTable(
  'design_versions',
  {
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    parentVersion: integer('parent_version').notNull(),
    author: text('author').$type<'user' | 'agent' | 'proposer'>().notNull(),
    doc: jsonb('doc').$type<DesignDocument>().notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.version] })],
);

export const proposalEvents = pgTable(
  'proposal_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    fdi: integer('fdi').notNull(),
    step: text('step').notNull(),
    proposerId: text('proposer_id').notNull(),
    action: text('action').notNull(),
    event: jsonb('event').$type<ProposalEvent>().notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index('proposal_events_org_case_idx').on(t.orgId, t.caseId), index('proposal_events_step_idx').on(t.step, t.proposerId)],
);

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('llm_usage_org_created_idx').on(t.orgId, t.createdAt)],
);
