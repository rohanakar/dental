import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import * as auth from './auth';
import * as api from './client';

/**
 * Drives the real client against a running API:
 *   WEB_API_E2E_URL=http://127.0.0.1:3000 npx vitest run src/api/client.e2e.test.ts
 * The API's PUBLIC_URL/TRUSTED_ORIGINS must include http://localhost:5173.
 */
const BASE = process.env.WEB_API_E2E_URL;
const ORIGIN = 'http://localhost:5173';

describe.skipIf(!BASE)('api client against a live API', () => {
  const cookies = new Map<string, string>();
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    // Browser stand-in: same-origin cookies and an Origin header (Better Auth checks it).
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('origin', ORIGIN);
      if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
      // The app's origin (absolute URLs from the auth client) maps to the API under test.
      const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
      const res = await realFetch(new URL(url.pathname + url.search, BASE), { ...init, headers });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = pair!.split('=');
        cookies.set(k!, v ?? '');
      }
      return res;
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('signs up, out and in through the Better Auth client', async () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    const email = `e2e-auth-${Date.now()}@example.com`;
    const user = await auth.signUp(email, 'correct-horse-battery', 'Auth E2E');
    expect(user.email).toBe(email);
    expect((await auth.getSession())?.email).toBe(email);
    await auth.signOut();
    cookies.clear();
    expect(await auth.getSession()).toBeNull();
    await expect(auth.signIn(email, 'wrong-password-123')).rejects.toBeInstanceOf(auth.AuthError);
    expect((await auth.signIn(email, 'correct-horse-battery')).email).toBe(email);
    expect((await api.me()).orgId).toBeTruthy();
    cookies.clear();
  });

  it('signs up, creates a case, uploads, saves, reloads and downloads', async () => {
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    const signUp = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `e2e-${Date.now()}@example.com`, password: 'correct-horse-battery', name: 'E2E' }),
    });
    expect(signUp.status).toBe(200);
    const who = await api.me();
    expect(who.orgId).toBeTruthy();

    const setup = { patientRef: 'E2E-1', teeth: [{ fdi: 36, restoration: 'anatomic-crown' as const, material: 'zirconia' as const }], notes: '' };
    const created = await api.createCase(setup);
    expect((await api.listCases()).map((c) => c.id)).toContain(created.id);
    expect(await api.latestVersion(created.id)).toBeNull();

    const bytes = new TextEncoder().encode('solid e2e\n'.repeat(5000));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = await api.uploadFile(created.id, { kind: 'lower', name: 'lower.stl', sha256, blob: new Blob([bytes]) });
    expect(file.encoding).toBe('gzip');
    expect(file.bytes).toBeLessThan(bytes.byteLength);

    const doc = {
      ...newDocument(created.id, setup),
      scans: [{ role: 'lower' as const, name: 'lower.stl', mesh: { sha256, fileId: file.id, units: 'mm' as const, frame: 'scan' as const } }],
    };
    const v1 = await api.saveVersion(created.id, { parentVersion: 0, author: 'user', doc });
    expect(v1.version).toBe(1);
    const stale = await api.saveVersion(created.id, { parentVersion: 0, author: 'user', doc }).catch((e) => e);
    expect(stale).toMatchObject({ status: 409, code: 'conflict' });
    const updated = await api.updateCase(created.id, { setup, status: 'in-design' });
    expect(updated.status).toBe('in-design');

    const detail = await api.getCase(created.id);
    expect(detail.files.map((f) => f.id)).toEqual([file.id]);
    const latest = await api.latestVersion(created.id);
    expect(latest?.version).toBe(1);
    expect(latest?.doc.scans[0]?.mesh.fileId).toBe(file.id);

    const downloaded = new Uint8Array(await api.downloadFile(file.id));
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(sha256);
  });
});
