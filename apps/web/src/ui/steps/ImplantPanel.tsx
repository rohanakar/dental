import { bridgeOf } from '@dcad/shared';
import { useEffect, useState } from 'react';
import { useDesignStore, selectActiveTooth } from '../../design/store';
import { bridgeRequest } from '../../tools/bridgeTool';
import { toothContext } from '../../tools/context';
import { entryFor, implantCrownRequest, implantTool, isImplantTooth, useImplantStore } from '../../tools/implantTool';
import type { CrownRequest } from '../../workers/analysisTypes';

/**
 * Implant crowns in the steps (specs/2026-10-25-implant-bridges.md): the implant position (the margin step of an
 * implant crown), the insertion axis (the implant axis, or a bridge's common path over its implants) and the screw
 * channel (Proposal). Each panel renders nothing for a crown on a prepared tooth.
 */

const mm = (v: number) => `${v.toFixed(3)} mm`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const deg = (v: number) => `${v.toFixed(1)}°`;

/** The active tooth is an implant crown. */
export const useIsImplant = (): boolean => useDesignStore((s) => isImplantTooth(s.doc, s.activeFdi));

/** Implant position step: click the scan body, check the match, accept. */
export function ImplantPositionPanel() {
  const tooth = useDesignStore(selectActiveTooth);
  const doc = useDesignStore((s) => s.doc);
  const library = useImplantStore((s) => s.library);
  const entryKey = useImplantStore((s) => s.entryKey);
  const match = useImplantStore((s) => s.match);
  const matching = useImplantStore((s) => s.matching);
  const error = useImplantStore((s) => s.error);
  useEffect(() => {
    void implantTool.loadLibrary();
  }, []);
  if (!tooth) return null;
  if (!tooth.frame) return <div className="step-body warning">Set the tooth frame first: click the top of the scan body in the Tooth frame step.</div>;
  const bridged = Boolean(bridgeOf(doc, tooth.fdi));
  // Single units engage the implant (anti-rotation); bridge units do not (one path over all implants).
  const entries = (library ?? []).filter((e) => e.engaging !== bridged);
  const entry = (entryKey && entries.find((e) => e.key === entryKey)) || (library ? entryFor(doc, tooth.fdi, library) : undefined);
  const pending = match && match.fdi === tooth.fdi && !match.accepted ? match : null;
  const stored = tooth.implant;

  return (
    <div className="step-body">
      <p className="hint-box">
        {pending
          ? pending.result.passed
            ? 'Check the matched scan body (the ghost), then accept it, or click the scan body again.'
            : 'The match failed its check: click again on the flat top of the scan body.'
          : 'Click the top of the scan body. The library scan body is matched to it.'}
      </p>
      <div className="field">
        <label htmlFor="implant-entry">Ti-base library</label>
        <select id="implant-entry" value={entry?.key ?? ''} onChange={(e) => implantTool.setEntry(e.target.value)} disabled={!library}>
          {entries.map((e) => (
            <option key={e.key} value={e.key}>
              {e.system} {e.platform}, {e.engaging ? 'engaging' : 'non-engaging'}
            </option>
          ))}
        </select>
        <span className="muted small">{bridged ? 'Bridges use non-engaging Ti-bases.' : 'Single units use an engaging Ti-base.'}</span>
      </div>
      {matching && (
        <div className="row muted">
          <span className="spinner" /> Matching the scan body…
        </div>
      )}
      {pending && (
        <>
          <dl className="params">
            <dt>Fit RMS</dt>
            <dd>{mm(pending.result.rmsMm)}</dd>
            <dt>Inliers</dt>
            <dd>{pct(pending.result.inlierFraction)}</dd>
            <dt>Coverage</dt>
            <dd>{pct(pending.result.coverage)}</dd>
            {pending.result.opening && (
              <>
                <dt>Gingiva above the platform</dt>
                <dd>{pending.result.opening.meanHeightMm.toFixed(2)} mm</dd>
              </>
            )}
          </dl>
          {!pending.result.passed && <div className="warning">{pending.result.failures.join('; ')}</div>}
          <div className="row">
            <button className="btn primary" disabled={!pending.result.passed} onClick={() => implantTool.accept()}>
              Accept match
            </button>
            <button className="btn ghost" onClick={() => implantTool.discard()}>
              Discard
            </button>
          </div>
        </>
      )}
      {stored && !pending && (
        <dl className="params">
          <dt>Ti-base</dt>
          <dd>
            {library?.find((e) => e.key === stored.libraryId)?.platform ?? stored.libraryId}, {stored.engaging ? 'engaging' : 'non-engaging'}
          </dd>
          <dt>Fit RMS</dt>
          <dd>{mm(stored.fit.rmsMm)}</dd>
          <dt>Inliers</dt>
          <dd>{pct(stored.fit.inlierFraction)}</dd>
        </dl>
      )}
      {error && <div className="warning">{error}</div>}
    </div>
  );
}

/** Axis step of an implant crown: its implant axis, or the common path over a bridge's implants. */
export function ImplantAxisPanel() {
  const tooth = useDesignStore(selectActiveTooth);
  const doc = useDesignStore((s) => s.doc);
  const path = useImplantStore((s) => s.path);
  const error = useImplantStore((s) => s.error);
  const [busy, setBusy] = useState(false);
  if (!tooth) return null;
  if (!tooth.implant) return <div className="step-body warning">Match the scan body first (Implant position).</div>;
  const bridge = bridgeOf(doc, tooth.fdi);
  const axis = tooth.axis;

  if (!bridge) {
    return (
      <div className="step-body">
        <p className="muted">A single implant crown seats along its implant axis, onto its engaging Ti-base.</p>
        <div className="row">
          <button className={`btn${axis ? '' : ' primary'}`} onClick={() => implantTool.useImplantAxis()}>
            Use the implant axis
          </button>
        </div>
        {axis && (
          <dl className="params">
            <dt>Source</dt>
            <dd>{axis.source === 'auto' ? 'implant axis' : 'edited'}</dd>
          </dl>
        )}
      </div>
    );
  }
  return (
    <div className="step-body">
      <p className="muted">
        The bridge seats on its non-engaging Ti-bases along one path: the direction closest to every implant axis. Implants that
        diverge more than the Ti-base library allows cannot share it.
      </p>
      <div className="row">
        <button
          className={`btn${axis ? '' : ' primary'}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void implantTool.commonPath().finally(() => setBusy(false));
          }}
        >
          Common path
        </button>
      </div>
      {path && (
        <dl className="params">
          <dt>Divergence</dt>
          <dd className={path.ok ? '' : 'fail'}>
            {deg(path.divergenceDeg)} (limit {deg(path.maxDivergenceDeg)})
          </dd>
          {path.implants.map((i) => (
            <span key={i.fdi} style={{ display: 'contents' }}>
              <dt>{i.fdi} off the path</dt>
              <dd>{deg(i.angleToPathDeg)}</dd>
            </span>
          ))}
        </dl>
      )}
      {error && <div className="warning">{error}</div>}
    </div>
  );
}

/** The request the auto-angle runs on: the active unit as designed (alone, or in its bridge on the common path). */
function channelRequest(): CrownRequest | null {
  const ctx = toothContext();
  if (!ctx) return null;
  const { doc } = useDesignStore.getState();
  if (!bridgeOf(doc, ctx.fdi)) return implantCrownRequest(ctx, true, 'none');
  let request;
  try {
    request = bridgeRequest(doc, ctx.fdi);
  } catch {
    return null;
  }
  const unit = request?.units.find((u) => u.fdi === ctx.fdi);
  if (!request || !unit?.frame || !unit.implant) return null;
  return {
    jawSha: request.jawSha,
    ...(request.antagonistSha ? { antagonistSha: request.antagonistSha } : {}),
    fdi: ctx.fdi,
    frame: unit.frame,
    margin: new Float32Array(0),
    axis: request.axis,
    params: unit.params,
    ...(unit.pose ? { pose: unit.pose } : {}),
    implant: unit.implant,
  };
}

/** Proposal step of an implant crown: the screw channel, straight or angled up to the library maximum. */
export function ScrewChannelPanel() {
  const tooth = useDesignStore(selectActiveTooth);
  const library = useImplantStore((s) => s.library);
  const result = useImplantStore((s) => s.result);
  const busy = useImplantStore((s) => s.channelBusy);
  const error = useImplantStore((s) => s.error);
  const stored = tooth?.screwChannel;
  const [angle, setAngle] = useState(stored?.angleDeg ?? 0);
  const [azimuth, setAzimuth] = useState(stored?.azimuthDeg ?? 0);
  useEffect(() => {
    setAngle(stored?.angleDeg ?? 0);
    setAzimuth(stored?.azimuthDeg ?? 0);
  }, [stored?.angleDeg, stored?.azimuthDeg]);
  useEffect(() => {
    void implantTool.loadLibrary();
  }, []);
  if (!tooth?.implant || !tooth.crown) return null;
  const max = tooth.implant.ascMaxDeg;
  const channel = result?.channel;
  const entry = library?.find((e) => e.key === tooth.implant!.libraryId);

  return (
    <fieldset className="view-controls">
      <legend>Screw channel</legend>
      <div className="row">
        <span className="muted">Angle</span>
        <input type="range" min={0} max={max} step={0.5} value={angle} aria-label="Channel angle" onChange={(e) => setAngle(Number(e.target.value))} />
        <span>{deg(angle)}</span>
      </div>
      <div className="row">
        <span className="muted">Toward</span>
        <input type="range" min={0} max={355} step={5} value={azimuth} aria-label="Channel azimuth" onChange={(e) => setAzimuth(Number(e.target.value))} />
        <span>{Math.round(azimuth)}°</span>
      </div>
      <p className="muted small">0° buccal, 90° mesial, 180° lingual, 270° distal; at most {deg(max)} from the implant axis.</p>
      <div className="row wrap">
        <button className="btn" disabled={busy} onClick={() => implantTool.setChannel(angle, azimuth)}>
          Apply
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => implantTool.setChannel(0, 0)}>
          Straight
        </button>
        <button className="btn" disabled={busy} onClick={() => void implantTool.autoChannel(channelRequest())}>
          {busy ? 'Searching…' : 'Auto angle'}
        </button>
      </div>
      {channel && (
        <dl className="params">
          <dt>Channel</dt>
          <dd>
            Ø {(channel.radiusMm * 2).toFixed(1)} mm{entry ? `, ${entry.platform}` : ''}, {channel.angleDeg ? `${deg(channel.angleDeg)} toward ${Math.round(channel.azimuthDeg)}°` : 'straight'}
          </dd>
          <dt>Exit</dt>
          <dd className={channel.exitOk ? '' : 'fail'}>{channel.exitOk ? 'occlusal / lingual' : 'buccal or proximal'}</dd>
          <dt>Thinnest wall</dt>
          <dd className={channel.wallOk ? '' : 'fail'}>
            {Number.isFinite(channel.minWallMm) ? `${channel.minWallMm.toFixed(2)} mm` : '—'} (min {channel.requiredWallMm} mm)
          </dd>
          {result && (
            <>
              <dt>Bonding gap</dt>
              <dd className={result.rimUndercutCount === 0 && result.tiBaseGap.intaglioMinGapMm > 0 ? '' : 'fail'}>
                {result.rimUndercutCount > 0 ? `${result.rimUndercutCount} shoulder points hidden: cannot seat` : `±${result.tiBaseGap.maxErrorMm.toFixed(3)} mm`}
              </dd>
            </>
          )}
        </dl>
      )}
      {channel?.failures.map((f) => (
        <div key={f} className="warning">
          {f}
        </div>
      ))}
      {error && <div className="warning">{error}</div>}
    </fieldset>
  );
}
