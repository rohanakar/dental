import { z } from 'zod';
import { CaseSetup, Fdi } from './case';
import { DesignDocument } from './design';
import { Sha256 } from './geometry';

/** REST DTOs shared by apps/api and apps/web. */

export const CaseStatus = z.enum(['draft', 'in-design', 'done']);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CaseSummary = z.object({
  id: z.string(),
  patientRef: z.string(),
  teeth: z.array(Fdi),
  status: CaseStatus,
  currentVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const CreateCaseRequest = z.object({ setup: CaseSetup });
export type CreateCaseRequest = z.infer<typeof CreateCaseRequest>;

export const UpdateCaseRequest = z.object({ status: CaseStatus.optional(), setup: CaseSetup.optional() });
export type UpdateCaseRequest = z.infer<typeof UpdateCaseRequest>;

export const FileKind = z.enum(['upper', 'lower', 'preop', 'export', 'artifact']);
export type FileKind = z.infer<typeof FileKind>;

/**
 * Upload: POST /api/cases/:id/files?kind=&name=&sha256=&encoding=gzip|identity
 * with the raw (optionally gzipped) bytes as the body. sha256 is of the
 * uncompressed bytes. Download: GET /api/files/:id streams the stored bytes
 * with Content-Encoding set, so browsers decompress transparently.
 */
export const UploadFileQuery = z.object({
  kind: FileKind,
  name: z.string().min(1).max(256),
  sha256: Sha256,
  encoding: z.enum(['identity', 'gzip']).default('identity'),
});
export type UploadFileQuery = z.infer<typeof UploadFileQuery>;

export const CaseFile = z.object({
  id: z.string(),
  caseId: z.string(),
  kind: FileKind,
  name: z.string(),
  sha256: Sha256,
  /** Stored size (after compression). */
  bytes: z.number().int().nonnegative(),
  contentType: z.string(),
  encoding: z.enum(['identity', 'gzip']),
  createdAt: z.string(),
});
export type CaseFile = z.infer<typeof CaseFile>;

/** GET /api/cases/:id */
export const CaseDetail = CaseSummary.extend({
  setup: CaseSetup,
  files: z.array(CaseFile),
});
export type CaseDetail = z.infer<typeof CaseDetail>;

/** GET /api/me */
export const Me = z.object({
  userId: z.string(),
  orgId: z.string(),
  role: z.string(),
});
export type Me = z.infer<typeof Me>;

export const VersionAuthor = z.enum(['user', 'agent', 'proposer']);

export const SaveVersionRequest = z.object({
  /** Optimistic concurrency: must equal the case's current version. */
  parentVersion: z.number().int().nonnegative(),
  author: VersionAuthor,
  doc: DesignDocument,
});
export type SaveVersionRequest = z.infer<typeof SaveVersionRequest>;

export const DesignVersion = z.object({
  caseId: z.string(),
  version: z.number().int().positive(),
  parentVersion: z.number().int().nonnegative(),
  author: VersionAuthor,
  doc: DesignDocument,
  createdAt: z.string(),
});
export type DesignVersion = z.infer<typeof DesignVersion>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;
