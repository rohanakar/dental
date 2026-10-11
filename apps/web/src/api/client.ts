import {
  ApiError,
  CaseDetail,
  CaseFile,
  CaseSetup,
  CaseSummary,
  DesignVersion,
  LlmResponse,
  Me,
  type CreateCaseRequest,
  type LlmRequest,
  type ProposalEvent,
  type FileKind,
  type SaveVersionRequest,
  type UpdateCaseRequest,
} from '@dcad/shared';
import { z } from 'zod';
import { apiUrl } from '../io/urls';

/** What POST/PATCH /api/cases return: the summary plus the setup (no files). */
export const CaseRecord = CaseSummary.extend({ setup: CaseSetup });
export type CaseRecord = z.infer<typeof CaseRecord>;

/** Any non-2xx API response, or a network failure (status 0). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** True when the API could not be reached at all, or failed on its side (5xx). */
export const isUnavailable = (e: unknown): boolean => e instanceof ApiRequestError && (e.status === 0 || e.status >= 500);

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), { credentials: 'same-origin', ...init });
  } catch (e) {
    throw new ApiRequestError(0, 'network_error', `Cannot reach the server (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.ok) return res;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON (e.g. a proxy error page).
  }
  const parsed = ApiError.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    throw new ApiRequestError(res.status, code, message, details);
  }
  throw new ApiRequestError(res.status, 'http_error', `Request failed with HTTP ${res.status}`);
}

async function json<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  return schema.parse(await res.json());
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const me = (): Promise<Me> => json(Me, 'me');

export const listCases = (): Promise<CaseSummary[]> => json(z.array(CaseSummary), 'cases');

export const createCase = (setup: CaseSetup): Promise<CaseRecord> =>
  json(CaseRecord, 'cases', jsonBody('POST', { setup } satisfies CreateCaseRequest));

export const getCase = (id: string): Promise<CaseDetail> => json(CaseDetail, `cases/${encodeURIComponent(id)}`);

export const updateCase = (id: string, patch: UpdateCaseRequest): Promise<CaseRecord> =>
  json(CaseRecord, `cases/${encodeURIComponent(id)}`, jsonBody('PATCH', patch));

/** Gzip a blob in the browser. Buffered: streaming request bodies need HTTP/2. */
export async function gzip(blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/**
 * Upload a file to a case, gzipped. `sha256` is of the uncompressed bytes;
 * the server verifies it after decompressing.
 */
export async function uploadFile(
  caseId: string,
  file: { kind: FileKind; name: string; sha256: string; blob: Blob },
): Promise<CaseFile> {
  const query = new URLSearchParams({ kind: file.kind, name: file.name, sha256: file.sha256, encoding: 'gzip' });
  const body = await gzip(file.blob);
  return json(CaseFile, `cases/${encodeURIComponent(caseId)}/files?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
}

/** Download a file's original bytes (the browser undoes Content-Encoding: gzip). */
export async function downloadFile(fileId: string): Promise<ArrayBuffer> {
  const res = await send(`files/${encodeURIComponent(fileId)}`);
  return res.arrayBuffer();
}

/** Latest saved design version, or null when the case has never been saved. */
export async function latestVersion(caseId: string): Promise<DesignVersion | null> {
  try {
    return await json(DesignVersion, `cases/${encodeURIComponent(caseId)}/versions/latest`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404 && e.code === 'not_found') return null;
    throw e;
  }
}

export const saveVersion = (caseId: string, request: SaveVersionRequest): Promise<DesignVersion> =>
  json(DesignVersion, `cases/${encodeURIComponent(caseId)}/versions`, jsonBody('POST', request));

/** LLM proxy: the server picks provider + model for the purpose and holds the keys. */
export const llm = (request: LlmRequest): Promise<LlmResponse> => json(LlmResponse, 'llm/messages', jsonBody('POST', request));

/** Data flywheel: record a proposal and what the user did with it. */
export const postProposalEvent = (event: ProposalEvent): Promise<{ id: string }> =>
  json(z.object({ id: z.string() }), 'proposal-events', jsonBody('POST', event));
