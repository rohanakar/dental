import { bridgeOf, ProposalEvent, stepsFor, unitKind, type ConnectorDesign, type ProposerId, type StepId } from '@dcad/shared';
import { create } from 'zustand';
import { useDesignStore } from '../design/store';
import { LOCAL_CASE_ID } from '../design/document';
import { apiUrl } from '../io/urls';
import { useSessionStore } from '../state/session';

export const APP_VERSION = '0.6.0';

export type ProposalAction = ProposalEvent['action'];

interface EventLogState {
  /** Events not yet stored on the server (offline, or the POST failed). */
  queued: ProposalEvent[];
  /** Events the server accepted (ids), for display and tests. */
  sent: number;
  lastError: string | null;
}

export const useEventLog = create<EventLogState>()(() => ({ queued: [], sent: 0, lastError: null }));

/**
 * Build a ProposalEvent (the data flywheel): the proposal as a JSON artifact,
 * what the user ended up with, and a snapshot of the inputs (scan hashes,
 * params, app and document version) so it can become a training example.
 */
export function buildProposalEvent(input: {
  fdi: number;
  step: StepId;
  proposerId: ProposerId;
  proposal: unknown;
  finalAccepted?: unknown;
  action: ProposalAction;
  editsCount?: number;
  durationMs: number;
}): ProposalEvent {
  const { doc, version } = useDesignStore.getState();
  const tooth = doc.teeth.find((t) => t.fdi === input.fdi);
  if (!tooth) throw new Error(`Tooth ${input.fdi} is not in the document`);
  return ProposalEvent.parse({
    caseId: doc.caseId,
    fdi: input.fdi,
    step: input.step,
    proposerId: input.proposerId,
    inputSnapshot: { scanHashes: doc.scans.map((s) => s.mesh.sha256), params: tooth.params, appVersion: APP_VERSION, docVersion: version },
    proposal: { kind: 'json', value: input.proposal },
    ...(input.finalAccepted !== undefined ? { finalAccepted: { kind: 'json', value: input.finalAccepted } } : {}),
    action: input.action,
    editsCount: input.editsCount ?? 0,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  });
}

/** What one bridge step proposed: an artifact per unit, plus the bridge's connector settings for the adapt step. */
export interface BridgeStepArtifact {
  /**
   * Per unit, in arch order: the unit's step output, as for a single crown. A pontic's proposal artifact is its pose
   * (the template crown it was given); its frame artifact is the frame laid out on the arch.
   */
  units: Array<{ fdi: number; artifact: unknown }>;
  /** Adapt step: the bridge's connector settings. */
  connectors?: ConnectorDesign[];
}

/**
 * The events of one bridge step: one ProposalEvent per unit, as for single crowns, so every unit is a training
 * example of its own. Rules:
 * - A unit gets an event only for the steps of its kind (stepsFor): a pontic has no margin or axis event. The common
 *   axis gives every abutment an event with the same direction.
 * - Connector settings belong to the bridge, not to a unit, so they are logged once: as `connectors` in the adapt
 *   artifact of the bridge's first unit in arch order (next to that unit's adaptation targets).
 * - Each event carries the step's duration: the step ran once for all units.
 */
export function buildBridgeProposalEvents(input: {
  step: StepId;
  proposerId: ProposerId;
  proposal: BridgeStepArtifact;
  finalAccepted?: BridgeStepArtifact;
  action: ProposalAction;
  editsCount?: number;
  durationMs: number;
}): ProposalEvent[] {
  const { doc } = useDesignStore.getState();
  const units = input.proposal.units.filter((u) => u.artifact !== undefined && stepsFor(unitKind(doc.setup, u.fdi)).includes(input.step));
  const listed = units.map((u) => u.fdi);
  const bridge = listed.length ? bridgeOf(doc, listed[0]!) : undefined;
  const lead = (bridge?.teeth ?? []).find((t) => listed.includes(t)) ?? listed[0];
  const artifactOf = (from: BridgeStepArtifact | undefined, fdi: number): unknown => {
    const own = from?.units.find((u) => u.fdi === fdi)?.artifact;
    if (input.step !== 'adapt' || fdi !== lead || !from?.connectors) return own;
    return { ...(own && typeof own === 'object' ? own : {}), connectors: from.connectors };
  };
  return units.map((u) => {
    const finalAccepted = artifactOf(input.finalAccepted, u.fdi);
    return buildProposalEvent({
      fdi: u.fdi,
      step: input.step,
      proposerId: input.proposerId,
      proposal: artifactOf(input.proposal, u.fdi),
      ...(finalAccepted !== undefined ? { finalAccepted } : {}),
      action: input.action,
      editsCount: input.editsCount,
      durationMs: input.durationMs,
    });
  });
}

async function sendEvent(event: ProposalEvent): Promise<void> {
  const res = await fetch(apiUrl('proposal-events'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`proposal-events: HTTP ${res.status}`);
}

/** Queue an event and try to send everything queued. Never throws into the UI. */
export function logProposalEvent(event: ProposalEvent): void {
  useEventLog.setState((s) => ({ queued: [...s.queued, event] }));
  void flushProposalEvents();
}

/** The flush in progress, and whether another pass was requested meanwhile. */
let flushing: Promise<void> | null = null;
let flushAgain = false;

/**
 * POST queued events for the open backend case. Offline documents (caseId
 * "local") and events of other cases stay queued; failures stay queued too.
 * Single-flight: a call while a flush is running schedules one more pass
 * instead of starting a second sender over the same queue (which would store
 * every event several times).
 */
export function flushProposalEvents(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        flushAgain = false;
        await flushOnce();
      } while (flushAgain);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

async function flushOnce(): Promise<void> {
  const caseId = useSessionStore.getState().currentCase?.id;
  if (!caseId) return;
  const pending = useEventLog.getState().queued.filter((e) => e.caseId === caseId && e.caseId !== LOCAL_CASE_ID);
  for (const event of pending) {
    try {
      await sendEvent(event);
      useEventLog.setState((s) => ({ queued: s.queued.filter((e) => e !== event), sent: s.sent + 1, lastError: null }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn('Proposal event not stored (kept in the queue):', message);
      useEventLog.setState({ lastError: message });
      return;
    }
  }
}
