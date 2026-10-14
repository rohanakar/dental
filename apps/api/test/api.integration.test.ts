import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentToolDefs,
  MATERIAL_PRESETS,
  STEP_ORDER,
  type CaseFile,
  type CaseSetup,
  type CaseSummary,
  type DesignDocument,
} from '@dcad/shared';
import { authed, buildTestApp, resetDatabase, signIn, signUp, TEST_INFRA, type TestApp } from './helpers';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const setup: CaseSetup = {
  patientRef: 'P-0001',
  teeth: [{ fdi: 36, restoration: 'anatomic-crown', material: 'zirconia', shade: 'A2' }],
  notes: '',
};

function designDoc(caseId: string): DesignDocument {
  return {
    schemaVersion: 1,
    caseId,
    setup,
    scans: [],
    teeth: [
      {
        fdi: 36,
        params: MATERIAL_PRESETS.zirconia,
        steps: Object.fromEntries(STEP_ORDER.map((s) => [s, s === 'setup' ? 'done' : 'pending'])) as DesignDocument['teeth'][number]['steps'],
      },
    ],
  };
}

async function countBlobs(root: string): Promise<number> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).length;
}

describe.skipIf(!TEST_INFRA)('API integration (Postgres from infra/docker-compose.test.yml)', () => {
  let t: TestApp;
  let cookieA: string;
  let cookieB: string;
  let caseId: string;
  let fileId: string;
  const original = randomBytes(300 * 1024);
  const gz = gzipSync(original);

  beforeAll(async () => {
    await resetDatabase();
    t = await buildTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await t.app.request('/api/cases');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('signs up into a personal organization and signs in again', async () => {
    const a = await signUp(t, 'a@lab.test', 'Alice');
    const me = await authed(t, a.cookie)('/api/me');
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { userId: string; orgId: string; role: string };
    expect(meBody.orgId).toBeTruthy();
    expect(meBody.role).toBe('owner');

    const again = await signIn(t, 'a@lab.test');
    cookieA = again.cookie;
    expect(((await (await authed(t, cookieA)('/api/me')).json()) as { orgId: string }).orgId).toBe(meBody.orgId);

    cookieB = (await signUp(t, 'b@lab.test', 'Bob')).cookie;
    const meB = (await (await authed(t, cookieB)('/api/me')).json()) as { orgId: string };
    expect(meB.orgId).not.toBe(meBody.orgId);
  });

  it('creates, lists and gets cases', async () => {
    const api = authed(t, cookieA);
    const created = await api('/api/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setup }),
    });
    expect(created.status).toBe(201);
    const c = (await created.json()) as CaseSummary;
    expect(c).toMatchObject({ patientRef: 'P-0001', teeth: [36], status: 'draft', currentVersion: 0 });
    caseId = c.id;

    const list = (await (await api('/api/cases')).json()) as CaseSummary[];
    expect(list.map((x) => x.id)).toContain(caseId);

    const got = (await (await api(`/api/cases/${caseId}`)).json()) as CaseSummary & { setup: CaseSetup; files: CaseFile[] };
    expect(got.setup.teeth[0]!.material).toBe('zirconia');
    expect(got.files).toEqual([]);

    const invalid = await api('/api/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setup: { ...setup, teeth: [{ fdi: 19, restoration: 'anatomic-crown', material: 'zirconia' }] } }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('uploads gzip with streaming sha256 verification and downloads it back', async () => {
    const api = authed(t, cookieA);
    const res = await api(
      `/api/cases/${caseId}/files?kind=upper&name=${encodeURIComponent('upper jaw.stl')}&sha256=${sha256(original)}&encoding=gzip`,
      { method: 'POST', headers: { 'content-type': 'model/stl' }, body: gz },
    );
    expect(res.status).toBe(201);
    const file = (await res.json()) as CaseFile;
    expect(file).toMatchObject({ kind: 'upper', name: 'upper jaw.stl', encoding: 'gzip', bytes: gz.length, contentType: 'model/stl' });
    fileId = file.id;

    const dl = await api(`/api/files/${fileId}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-encoding')).toBe('gzip');
    expect(dl.headers.get('content-length')).toBe(String(gz.length));
    expect(dl.headers.get('etag')).toBe(`"${sha256(original)}"`);
    const stored = Buffer.from(await dl.arrayBuffer());
    expect(gunzipSync(stored).equals(original)).toBe(true);
  });

  it('rejects sha256 mismatch, invalid gzip and oversize uploads without leaving blobs', async () => {
    const api = authed(t, cookieA);
    const before = await countBlobs(t.blobRoot);
    const filesBefore = ((await (await api(`/api/cases/${caseId}/files`)).json()) as CaseFile[]).length;

    const mismatch = await api(`/api/cases/${caseId}/files?kind=upper&name=x.stl&sha256=${'0'.repeat(64)}&encoding=gzip`, {
      method: 'POST',
      body: gz,
    });
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'integrity_error' } });

    const notGzip = await api(`/api/cases/${caseId}/files?kind=upper&name=x.stl&sha256=${sha256(original)}&encoding=gzip`, {
      method: 'POST',
      body: original,
    });
    expect(notGzip.status).toBe(400);
    expect(await notGzip.json()).toMatchObject({ error: { code: 'invalid_encoding' } });

    const big = randomBytes(3 * 1024 * 1024);
    const tooBig = await api(`/api/cases/${caseId}/files?kind=upper&name=big.stl&sha256=${sha256(big)}`, {
      method: 'POST',
      body: big,
    });
    expect(tooBig.status).toBe(413);

    expect(await countBlobs(t.blobRoot)).toBe(before);
    expect(((await (await api(`/api/cases/${caseId}/files`)).json()) as CaseFile[]).length).toBe(filesBefore);
  });

  it('isolates organizations', async () => {
    const api = authed(t, cookieB);
    expect((await api(`/api/cases/${caseId}`)).status).toBe(404);
    expect((await api(`/api/files/${fileId}`)).status).toBe(404);
    expect((await api(`/api/cases/${caseId}/versions/latest`)).status).toBe(404);
    expect(await (await api('/api/cases')).json()).toEqual([]);
    const upload = await api(`/api/cases/${caseId}/files?kind=upper&name=x.stl&sha256=${sha256(original)}`, {
      method: 'POST',
      body: original,
    });
    expect(upload.status).toBe(404);
    const patch = await api(`/api/cases/${caseId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(patch.status).toBe(404);
  });

  it('saves versions with optimistic concurrency', async () => {
    const api = authed(t, cookieA);
    const save = (parentVersion: number, doc = designDoc(caseId)) =>
      api(`/api/cases/${caseId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentVersion, author: 'user', doc }),
      });

    const first = await save(0);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ version: 1, parentVersion: 0, author: 'user' });

    const stale = await save(0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', details: { currentVersion: 1 } } });

    expect((await save(1)).status).toBe(201);
    const latest = await api(`/api/cases/${caseId}/versions/latest`);
    expect(await latest.json()).toMatchObject({ version: 2, parentVersion: 1 });

    const wrongCase = await save(2, designDoc('some-other-case'));
    expect(wrongCase.status).toBe(400);

    const summary = (await (await api(`/api/cases/${caseId}`)).json()) as CaseSummary;
    expect(summary.currentVersion).toBe(2);
  });

  it('proxies LLM calls through the configured provider and records usage', async () => {
    const api = authed(t, cookieA);
    const res = await api('/api/llm/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        purpose: 'agent',
        tools: agentToolDefs(),
        messages: [{ role: 'user', content: [{ type: 'text', text: '/tool move_crown {"fdi":36,"direction":"occlusal","mm":0.1}' }] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; stopReason: string; content: unknown[] };
    expect(body.provider).toBe('mock');
    expect(body.stopReason).toBe('tool_use');
    expect(body.content[0]).toMatchObject({ type: 'tool_call', name: 'move_crown' });

    const rows = await t.db.db.execute(sql`select provider, model, purpose from llm_usage`);
    expect(rows.rows).toContainEqual({ provider: 'mock', model: 'mock-1', purpose: 'agent' });

    const bad = await api('/api/llm/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'free-for-all', messages: [] }),
    });
    expect(bad.status).toBe(400);
  });
});
