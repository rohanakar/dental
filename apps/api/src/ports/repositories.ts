import type {
  CaseFile,
  CaseSetup,
  CaseStatus,
  CaseSummary,
  DesignDocument,
  DesignVersion,
  FileKind,
  ProposalEvent,
} from '@dcad/shared';

/** Persistence ports. Every method is scoped by orgId; implementations must filter on it. */

export interface CaseRecord extends CaseSummary {
  setup: CaseSetup;
}

export interface CaseRepository {
  create(input: { id: string; orgId: string; createdBy: string; setup: CaseSetup }): Promise<CaseRecord>;
  list(orgId: string, limit: number): Promise<CaseSummary[]>;
  get(orgId: string, caseId: string): Promise<CaseRecord | null>;
  update(
    orgId: string,
    caseId: string,
    patch: { status?: CaseStatus; setup?: CaseSetup },
  ): Promise<CaseRecord | null>;
}

export interface FileRecord extends CaseFile {
  orgId: string;
  blobKey: string;
}

export interface FileRepository {
  insert(input: {
    id: string;
    orgId: string;
    caseId: string;
    kind: FileKind;
    name: string;
    sha256: string;
    bytes: number;
    contentType: string;
    encoding: 'identity' | 'gzip';
    blobKey: string;
    createdBy: string;
  }): Promise<FileRecord>;
  get(orgId: string, fileId: string): Promise<FileRecord | null>;
  listForCase(orgId: string, caseId: string): Promise<FileRecord[]>;
}

export type SaveVersionResult =
  | { ok: true; version: DesignVersion }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; currentVersion: number };

export interface VersionRepository {
  /**
   * Atomically bump the case's current version iff it equals parentVersion,
   * then store the document as the new version.
   */
  save(input: {
    orgId: string;
    caseId: string;
    parentVersion: number;
    author: DesignVersion['author'];
    doc: DesignDocument;
    createdBy: string;
  }): Promise<SaveVersionResult>;
  latest(orgId: string, caseId: string): Promise<DesignVersion | null>;
}

export interface ProposalEventRepository {
  insert(input: { id: string; orgId: string; createdBy: string; event: ProposalEvent }): Promise<void>;
}

export interface LlmUsageRecord {
  orgId: string;
  userId: string;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmUsageRepository {
  insert(record: LlmUsageRecord): Promise<void>;
}

export interface HealthProbe {
  ping(): Promise<void>;
}

export interface Repositories {
  cases: CaseRepository;
  files: FileRepository;
  versions: VersionRepository;
  proposalEvents: ProposalEventRepository;
  llmUsage: LlmUsageRepository;
  health: HealthProbe;
}
