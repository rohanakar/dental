import { useEffect, useRef, useState } from 'react';
import { useAssistant } from '../../ai/agent';
import { useDesignStore } from '../../design/store';
import { useSessionStore } from '../../state/session';
import { useToolStore } from '../../tools/toolStore';
import './ai.css';

const EXAMPLES = ['Make the crown 0.3 mm shorter', 'Tighten the mesial contact to 0.01 mm', 'What is the occlusal clearance?'];
const MOCK_HINT = '/tool move_crown {"fdi":36,"direction":"mesial","mm":0.2}';

/**
 * Design assistant: natural-language edits run as an LLM tool loop over the
 * clinical commands. All changes of one request stay in a transaction until
 * the user accepts (one undo entry) or reverts them.
 */
export function AssistantPanel() {
  const offline = useSessionStore((s) => s.offline);
  const hasCase = useSessionStore((s) => Boolean(s.currentCase));
  const { messages, running, send, accept, revert, clear } = useAssistant();
  const transaction = useDesignStore((s) => s.transaction);
  const pending = transaction?.author === 'agent';
  const otherOpen = Boolean(transaction && !pending);
  const [input, setInput] = useState('');
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages.length]);

  if (offline || !hasCase) {
    return (
      <div className="assistant">
        <div className="muted small">The assistant needs the server (sign in and open a case).</div>
      </div>
    );
  }

  const submit = () => {
    if (!input.trim() || running) return;
    void send(input);
    setInput('');
  };

  return (
    <div className="assistant">
      {messages.length === 0 ? (
        <div className="muted small">
          Ask for a change in clinical terms, for example:
          <ul className="assistant-examples">
            {EXAMPLES.map((e) => (
              <li key={e}>
                <button type="button" className="link-btn" onClick={() => setInput(e)}>
                  {e}
                </button>
              </li>
            ))}
          </ul>
          {import.meta.env.DEV && (
            <>
              With the server's mock provider (no API key) you can call a tool directly: <code>{MOCK_HINT}</code>
            </>
          )}
        </div>
      ) : (
        <div className="assistant-log" ref={log} role="log" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`assistant-msg ${m.role}${m.ok === false ? ' failed' : ''}`}>
              {m.role === 'tool' ? <code>{m.text}</code> : m.text}
            </div>
          ))}
          {running && (
            <div className="assistant-msg note">
              <span className="spinner" /> Working…
            </div>
          )}
        </div>
      )}
      {pending && (
        <div className="assistant-banner" role="status">
          <span>The assistant changed the design.</span>
          <button
            className="btn primary"
            onClick={() => {
              accept();
              useToolStore.getState().set({ message: { kind: 'info', text: "Assistant's changes accepted. Undo takes them back in one step." } });
            }}
            disabled={running}
          >
            Accept
          </button>
          <button
            className="btn"
            onClick={() => {
              revert();
              useToolStore.getState().set({ message: { kind: 'info', text: "Assistant's changes reverted." } });
            }}
            disabled={running}
          >
            Revert
          </button>
        </div>
      )}
      {otherOpen && <div className="warning">Accept or reject the open proposal ({transaction?.label}) first.</div>}
      <div className="assistant-input">
        <textarea
          rows={2}
          value={input}
          placeholder="Describe the change…"
          aria-label="Instruction for the design assistant"
          disabled={running || otherOpen}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="row">
          <button className="btn primary" onClick={submit} disabled={running || otherOpen || !input.trim()}>
            Send
          </button>
          {messages.length > 0 && (
            <button className="btn ghost" onClick={clear} disabled={running}>
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
