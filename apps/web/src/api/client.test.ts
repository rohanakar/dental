import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { ApiRequestError, createCase, downloadFile, isUnavailable, latestVersion, listCases, saveVersion, uploadFile } from './client';

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
    let sent: { url: string; body: Uint8Array; headers: Headers } | null = null;
    mockFetch(async (url, init) => {
      sent = { url, body: new Uint8Array(await (init.body as Blob).arrayBuffer()), headers: new Headers(init.headers) };
      return jsonResponse(
        {
          id: 'f1',
          caseId: 'c1',
          kind: 'lower',
          name: 'lower jaw.stl',
          sha256: SHA,
          bytes: 10,
          contentType: 'model/stl',
          encoding: 'gzip',
          createdAt: NOW,
        },
        201,
      );
    });
    const original = new TextEncoder().encode('solid demo\n'.repeat(100));
    const file = await uploadFile('c1', { kind: 'lower', name: 'lower jaw.stl', sha256: SHA, blob: new Blob([original]) });
    expect(file.id).toBe('f1');
    const url = new URL(sent!.url, 'http://x');
    expect(url.pathname).toBe('/api/cases/c1/files');
    expect(Object.fromEntries(url.searchParams)).toEqual({ kind: 'lower', name: 'lower jaw.stl', sha256: SHA, encoding: 'gzip' });
    expect(sent!.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(gunzipSync(sent!.body))).toEqual(original);
  });

  it('returns null when a case has no saved version', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'not_found', message: 'Design version not found' } }, 404));
    expect(await latestVersion('c1')).toBeNull();
  });

  it('maps API errors, including details', async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: 'conflict', message: 'Case was modified', details: { currentVersion: 3 } } }, 409),
    );
    const error = await saveVersion('c1', { parentVersion: 1, author: 'user', doc: newDocument('c1') }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', details: { currentVersion: 3 } });
    expect(isUnavailable(error)).toBe(false);
  });

  it('reports network failures and non-JSON 5xx as unavailable', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const network = await listCases().catch((e) => e);
    expect(network).toMatchObject({ status: 0, code: 'network_error' });
    expect(isUnavailable(network)).toBe(true);
    mockFetch(() => new Response('Bad gateway', { status: 502 }));
    const gateway = await listCases().catch((e) => e);
    expect(gateway).toMatchObject({ status: 502, code: 'http_error' });
    expect(isUnavailable(gateway)).toBe(true);
  });

  it('validates responses against the shared schemas', async () => {
    mockFetch(() => jsonResponse({ id: 'c1', patientRef: 'x' }, 201));
    await expect(
      createCase({ patientRef: 'x', teeth: [{ fdi: 36, restoration: 'anatomic-crown', material: 'zirconia' }], notes: '' }),
    ).rejects.toThrow();
  });

  it('downloads file bytes', async () => {
    const fetchMock = mockFetch(() => new Response(new Uint8Array([1, 2, 3])));
    expect(new Uint8Array(await downloadFile('f/1'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/files/f%2F1');
  });
});
