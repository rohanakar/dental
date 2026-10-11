import { ProposalEvent } from '@dcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newDocument } from '../design/document';
import { useDesignStore } from '../design/store';

const session = { currentCase: null as null | { id: string } };
vi.mock('../state/session', () => ({ useSessionStore: { getState: () => session } }));

const { buildProposalEvent, flushProposalEvents, logProposalEvent, useEventLog } = await import('./events');

describe('proposal events', () => {
  beforeEach(() => {
    useEventLog.setState({ queued: [], sent: 0, lastError: null });
    session.currentCase = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('builds schema-valid events with an input snapshot', () => {
    useDesignStore.getState().load(newDocument('case-1'), 3);
    const e = buildProposalEvent({ fdi: 36, step: 'axis', proposerId: 'classical.axis-least-undercut@1', proposal: { direction: [0, 0, 1] }, action: 'accepted', durationMs: 12.6 });
    expect(ProposalEvent.parse(e)).toEqual(e);
    expect(e.inputSnapshot.docVersion).toBe(3);
    expect(e.durationMs).toBe(13);
    expect(e.proposal).toEqual({ kind: 'json', value: { direction: [0, 0, 1] } });
  });

  it('keeps events queued offline and posts them when the case is open; failures stay queued', async () => {
    useDesignStore.getState().load(newDocument('case-1'), 1);
    const fetchMock = vi.fn(async () => new Response('{"id":"e1"}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    logProposalEvent(buildProposalEvent({ fdi: 36, step: 'margin', proposerId: 'classical.margin-ridge@1', proposal: {}, action: 'rejected', durationMs: 1 }));
    await flushProposalEvents();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useEventLog.getState().queued).toHaveLength(1);

    session.currentCase = { id: 'case-1' };
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await flushProposalEvents();
    expect(useEventLog.getState().queued).toHaveLength(1);
    expect(useEventLog.getState().lastError).toMatch(/500/);

    await flushProposalEvents();
    expect(useEventLog.getState()).toMatchObject({ queued: [], sent: 1, lastError: null });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toMatch(/api\/proposal-events$/);
    expect(JSON.parse(init.body as string).action).toBe('rejected');
  });

  it('never sends offline (local) documents', async () => {
    useDesignStore.getState().load(newDocument(), 0);
    session.currentCase = { id: 'local' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logProposalEvent(buildProposalEvent({ fdi: 36, step: 'frame', proposerId: 'classical.frame-seed@1', proposal: {}, action: 'accepted', durationMs: 1 }));
    await flushProposalEvents();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores each event once when several are logged while a flush is in flight', async () => {
    useDesignStore.getState().load(newDocument('case-1'), 1);
    session.currentCase = { id: 'case-1' };
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10)); // slow server: flushes overlap
      return new Response('{"id":"e"}', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const steps = ['frame', 'margin', 'axis', 'proposal', 'adapt'] as const;
    for (const step of steps) {
      logProposalEvent(buildProposalEvent({ fdi: 36, step, proposerId: 'classical.frame-seed@1', proposal: { step }, action: 'accepted', durationMs: 1 }));
    }
    await flushProposalEvents();
    await vi.waitFor(() => expect(useEventLog.getState().queued).toHaveLength(0));
    expect(fetchMock).toHaveBeenCalledTimes(steps.length);
    expect(useEventLog.getState().sent).toBe(steps.length);
  });
});
