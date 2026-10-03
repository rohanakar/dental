import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import { UploadFileQuery } from '@dcad/shared';
import { DomainError } from '../../domain/errors';
import type { Services } from '../app';
import type { AppEnv } from '../types';
import { readQuery } from '../validate';

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function fileRoutes(services: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * Streamed upload: raw (optionally gzipped) bytes as the body.
   * ?kind=&name=&sha256=<of uncompressed bytes>&encoding=gzip|identity
   */
  r.post('/cases/:id/files', async (c) => {
    const query = readQuery(c, UploadFileQuery);
    const body = c.req.raw.body;
    if (!body) throw new DomainError('validation_error', 'Request body is required');
    const file = await services.files.upload(
      c.get('auth'),
      c.req.param('id'),
      query,
      c.req.header('content-type'),
      Readable.fromWeb(body as unknown as NodeWebReadableStream),
    );
    return c.json(file, 201);
  });

  r.get('/cases/:id/files', async (c) => c.json(await services.files.listForCase(c.get('auth'), c.req.param('id'))));

  r.get('/files/:id', async (c) => {
    const { file, body, bytes } = await services.files.open(c.get('auth'), c.req.param('id'));
    const headers: Record<string, string> = {
      'Content-Type': file.contentType,
      'Content-Length': String(bytes),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${file.sha256}"`,
      'X-Content-Sha256': file.sha256,
    };
    if (file.encoding === 'gzip') headers['Content-Encoding'] = 'gzip';
    return new Response(Readable.toWeb(body) as unknown as ReadableStream, { status: 200, headers });
  });

  return r;
}
