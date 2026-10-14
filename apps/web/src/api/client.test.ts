import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { ApiRequestError, isUnavailable, latestVersion, listCases, saveVersion, uploadFile } from './client';

const SHA = 'a'.repeat(64);
const NOW = '2026-10-11T10:00:00.000Z';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('gzips uploads and sends the query the API expects', async () => {
    let sent: { url: string; body: Uint8Array } | null = null;
    mockFetch(async (url, init) => {
      sent = { url, body: new Uint8Array(await (init.body as Blob).arrayBuffer()) };
      return jsonResponse(
        { id: 'f1', caseId: 'c1', kind: 'lower', name: 'lower jaw.stl', sha256: SHA, bytes: 10, contentType: 'model/stl', encoding: 'gzip', createdAt: NOW },
        201,
      );
    });
    const original = new TextEncoder().encode('solid demo\n'.repeat(100));
    const file = await uploadFile('c1', { kind: 'lower', name: 'lower jaw.stl', sha256: SHA, blob: new Blob([original]) });
    expect(file.id).toBe('f1');
    const url = new URL(sent!.url, 'http://x');
    expect(url.pathname).toBe('/api/cases/c1/files');
    expect(Object.fromEntries(url.searchParams)).toEqual({ kind: 'lower', name: 'lower jaw.stl', sha256: SHA, encoding: 'gzip' });
    expect(new Uint8Array(gunzipSync(sent!.body))).toEqual(original);
  });

  it('maps API errors: no saved version, conflicts with details, and an unreachable API', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'not_found', message: 'Design version not found' } }, 404));
    expect(await latestVersion('c1')).toBeNull();

    mockFetch(() => jsonResponse({ error: { code: 'conflict', message: 'Case was modified', details: { currentVersion: 3 } } }, 409));
    const conflict = await saveVersion('c1', { parentVersion: 1, author: 'user', doc: newDocument('c1') }).catch((e) => e);
    expect(conflict).toBeInstanceOf(ApiRequestError);
    expect(conflict).toMatchObject({ status: 409, code: 'conflict', details: { currentVersion: 3 } });
    expect(isUnavailable(conflict)).toBe(false);

    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(isUnavailable(await listCases().catch((e) => e))).toBe(true);
    mockFetch(() => new Response('Bad gateway', { status: 502 }));
    expect(isUnavailable(await listCases().catch((e) => e))).toBe(true);
  });
});
