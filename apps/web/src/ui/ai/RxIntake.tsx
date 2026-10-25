import { bridgesOf, type CaseSetup, unitKind } from '@dcad/shared';
import { useState } from 'react';
import { classicalExtraction, extractRxWithLlm, type RxExtraction } from '../../ai/rx';
import { useDesignStore } from '../../design/store';
import { useSessionStore } from '../../state/session';
import { MATERIAL_LABEL } from '../steps/SetupStep';
import './ai.css';

/**
 * Prescription intake: paste the lab prescription, read it (LLM when the
 * server is reachable, otherwise the rule-based reader), review, then apply
 * as the case setup. Nothing changes until "Apply"; a setup the bridge rules
 * refuse cannot be applied.
 */
export function RxIntake() {
  const online = useSessionStore((s) => !s.offline && Boolean(s.currentCase));
  const current = useDesignStore((s) => s.doc.setup);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RxExtraction | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const read = async () => {
    setBusy(true);
    setApplyError(null);
    try {
      setResult(online ? await extractRxWithLlm(text) : classicalExtraction(text, 'Offline: used the rule-based reader.'));
    } finally {
      setBusy(false);
    }
  };

  const apply = (setup: CaseSetup) => {
    // The extracted teeth replace the current ones; an empty reference keeps the current one.
    const next: CaseSetup = {
      patientRef: setup.patientRef || current.patientRef,
      teeth: setup.teeth,
      notes: setup.notes || current.notes,
      connections: setup.connections,
    };
    try {
      useDesignStore.getState().dispatch({ type: 'setCaseSetup', setup: next });
    } catch (e) {
      setApplyError(`Not applied: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    useDesignStore.getState().setActiveFdi(next.teeth[0]!.fdi);
    setResult(null);
    setApplyError(null);
    setText('');
  };

  const diffFields = new Set(result?.differences.map((d) => d.field) ?? []);
  const errors = result?.issues.errors ?? [];
  const bridges = result ? bridgesOf(result.setup) : [];
  return (
    <details className="rx-intake">
      <summary>Read a prescription</summary>
      <textarea
        rows={4}
        value={text}
        placeholder="Paste a prescription (no patient names), e.g. 'Ref: LAB-12 — zirconia bridge 35-37, shade A2'"
        aria-label="Paste a prescription"
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button className="btn" disabled={busy || !text.trim()} onClick={() => void read()}>
          {busy ? 'Reading…' : 'Read prescription'}
        </button>
        <span className="muted small">{online ? 'AI reader with a rule-based cross-check' : 'Rule-based reader (offline)'}</span>
      </div>
      {result && (
        <div className="rx-result">
          <div className="muted small">Read by: {result.source === 'llm' ? 'AI' : 'rules'}</div>
          {result.valid ? (
            <dl className="params">
              <dt>Reference</dt>
              <dd className={diffFields.has('patientRef') ? 'rx-diff' : ''}>{result.setup.patientRef || '—'}</dd>
              {result.setup.teeth.map((t) => (
                <div key={t.fdi} className="rx-tooth">
                  <dt className={diffFields.has('teeth') ? 'rx-diff' : ''}>
                    Tooth {t.fdi}
                    {unitKind(result.setup, t.fdi) === 'pontic' && (
                      <span className={diffFields.has(`${t.fdi} restoration`) ? 'rx-diff' : ''}> (pontic)</span>
                    )}
                  </dt>
                  <dd>
                    <span className={diffFields.has(`${t.fdi} material`) ? 'rx-diff' : ''}>{MATERIAL_LABEL[t.material]}</span>
                    {', shade '}
                    <span className={diffFields.has(`${t.fdi} shade`) ? 'rx-diff' : ''}>{t.shade ?? '—'}</span>
                  </dd>
                </div>
              ))}
              {bridges.length > 0 && (
                <>
                  <dt>Bridges</dt>
                  <dd className={diffFields.has('connections') ? 'rx-diff' : ''}>{bridges.map((b) => b.join('–')).join('; ')}</dd>
                </>
              )}
              {result.setup.notes && (
                <>
                  <dt>Notes</dt>
                  <dd className="rx-notes">{result.setup.notes}</dd>
                </>
              )}
            </dl>
          ) : (
            <div className="warning">No tooth number found.</div>
          )}
          {result.differences.length > 0 && (
            <div className="warning">
              The AI and the rule-based reader disagree (highlighted):{' '}
              {result.differences.map((d) => `${d.field}: ${d.llm} vs ${d.classical}`).join('; ')}
            </div>
          )}
          {result.valid && errors.length > 0 && (
            <div className="error" role="alert">
              This setup cannot be applied: {errors.map((e) => e.message).join('; ')}. Correct the prescription, or set up
              the bridge in the tooth chart.
            </div>
          )}
          {result.issues.warnings.map((w) => (
            <div className="warning" key={w.code + w.teeth.join('-')}>
              {w.message}.
            </div>
          ))}
          {result.notes.map((n) => (
            <div className="muted small" key={n}>
              {n}
            </div>
          ))}
          {applyError && (
            <div className="error" role="alert">
              {applyError}
            </div>
          )}
          <div className="row">
            <button className="btn primary" disabled={!result.valid || errors.length > 0} onClick={() => apply(result.setup)}>
              Apply to case
            </button>
            <button className="btn ghost" onClick={() => setResult(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
