// The video overlay, installed in every document of an episode (context.addInitScript): a drawn cursor that follows the
// real mouse, captions, keycaps, check toasts, a ring to point at an element, and the title / end cards. All of it is
// pointer-events: none, so it never takes a click. The function is serialized into the page: no outside references.
export function installOverlay() {
  if (window.top !== window || window.__wt) return;
  const css = `
#wt-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
#wt-root *{box-sizing:border-box}
#wt-root p,#wt-root ul,#wt-root li{font-family:inherit;text-align:left}
#wt-cursor{position:absolute;left:0;top:0;width:26px;height:26px;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));opacity:0}
#wt-cursor.on{opacity:1}
#wt-cursor svg{width:26px;height:26px;transform-origin:3px 3px;transition:transform .12s}
#wt-cursor.down svg{transform:scale(.86)}
.wt-ripple{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(58,111,216,.95);background:rgba(58,111,216,.18);animation:wt-ripple .6s ease-out forwards}
@keyframes wt-ripple{from{transform:scale(.25);opacity:1}to{transform:scale(1.25);opacity:0}}
#wt-caption{position:absolute;bottom:58px;left:50%;max-width:min(940px,calc(100vw - 48px));transform:translate(-50%,12px);opacity:0;transition:opacity .28s,transform .28s;background:rgba(14,19,28,.88);color:#fff;border-radius:14px;padding:14px 22px 16px;box-shadow:0 10px 30px rgba(0,0,0,.28);backdrop-filter:blur(6px)}
#wt-caption.on{opacity:1;transform:translate(-50%,0)}
#wt-caption .eyebrow{font-size:12.5px;letter-spacing:.06em;text-transform:uppercase;color:#9dbbff;font-weight:600;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wt-caption .text{font-size:21px;line-height:1.38;font-weight:450;text-wrap:pretty}
#wt-keys{position:absolute;bottom:186px;left:50%;transform:translate(-50%,8px);opacity:0;transition:opacity .2s,transform .2s;display:flex;align-items:center;gap:12px;background:rgba(14,19,28,.88);color:#fff;border-radius:12px;padding:10px 16px;font-size:17px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
#wt-keys.on{opacity:1;transform:translate(-50%,0)}
#wt-keys kbd{font:600 16px/1 "SF Mono",Menlo,monospace;background:#fff;color:#111;border-radius:7px;padding:7px 10px;box-shadow:0 2px 0 #9aa3b2}
#wt-keys .what{color:#cfd8e6}
#wt-toasts{position:absolute;right:22px;bottom:204px;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.wt-toast{display:flex;align-items:center;gap:10px;max-width:440px;background:#fff;color:#14181f;border-radius:11px;padding:10px 14px 10px 11px;font-size:15px;line-height:1.3;font-weight:500;box-shadow:0 8px 26px rgba(15,23,42,.22),0 0 0 1px rgba(15,23,42,.06);animation:wt-toast-in .3s ease-out}
.wt-toast .mark{flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:14px}
.wt-toast.ok .mark{background:#1f8a4c}.wt-toast.bad .mark{background:#d1343b}
.wt-toast .tag{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#68748a;font-weight:650;margin-bottom:1px}
.wt-toast.out{opacity:0;transform:translateX(16px);transition:opacity .35s,transform .35s}
@keyframes wt-toast-in{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
.wt-ring{position:absolute;border:3px solid #3a6fd8;border-radius:10px;box-shadow:0 0 0 5px rgba(58,111,216,.22),0 0 22px rgba(58,111,216,.45);animation:wt-ring 1.1s ease-in-out infinite}
@keyframes wt-ring{50%{box-shadow:0 0 0 9px rgba(58,111,216,.12),0 0 28px rgba(58,111,216,.55)}}
#wt-card{position:absolute;inset:0;display:grid;place-items:center;opacity:0;transition:opacity .6s;background:radial-gradient(1200px 700px at 20% 10%,#284f9e 0%,#14244a 45%,#0b1226 100%);color:#fff}
#wt-card.on{opacity:1}
#wt-card.on~#wt-cursor{opacity:0}
#wt-card.error{background:radial-gradient(1200px 700px at 20% 10%,#8f2a30 0%,#4a1418 50%,#1d0a0c 100%)}
#wt-card .inner{width:min(1040px,86vw)}
#wt-card .eyebrow{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#a9c3ff;font-weight:650}
#wt-card ul.checks{grid-template-columns:1fr 1fr;gap:10px 34px}
#wt-card ul.checks li{font-size:16.5px;color:#dfe8ff}
#wt-card ul.checks li::before{content:"✓";background:none;color:#5fd38d;font-weight:800;top:0;left:2px;width:auto;height:auto}
#wt-card ul.checks li.bad::before{content:"✕";color:#ff8a90}
#wt-card.error .eyebrow{color:#ffb3b8}
#wt-card .h1{font-size:60px;line-height:1.05;letter-spacing:-.02em;margin:14px 0 18px;font-weight:750;color:#fff}
#wt-card p{font-size:23px;line-height:1.45;color:#dbe5ff;margin:0;max-width:880px;text-wrap:pretty}
#wt-card ul{margin:30px 0 0;padding:0;list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:12px 34px;max-width:960px}
#wt-card li{font-size:18px;line-height:1.35;color:#eef3ff;padding-left:28px;position:relative}
#wt-card li::before{content:"";position:absolute;left:4px;top:.45em;width:10px;height:10px;border-radius:3px;background:#6f9bff}
#wt-card .foot{margin-top:40px;font-size:18px;color:#a9c3ff;font-weight:550}
#wt-card .brand{position:absolute;left:56px;bottom:40px;font-size:16px;font-weight:700;letter-spacing:.01em;color:#c9d7ff}
#wt-card .brand span{font-weight:450;color:#8ea6d8}
`;
  const cursorSvg =
    '<svg viewBox="0 0 26 26"><path d="M3 2.5 L3 21 L8.2 16.3 L11.6 23.6 L15 22.1 L11.7 14.9 L18.8 14.9 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let root;
  const el = (tag, id, cls) => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (cls) e.className = cls;
    return e;
  };
  const parts = {};
  const mount = () => {
    if (root?.isConnected) return;
    const style = el('style');
    style.textContent = css;
    root = el('div', 'wt-root');
    root.append(style);
    parts.card = el('div', 'wt-card');
    parts.cursor = el('div', 'wt-cursor');
    parts.cursor.innerHTML = cursorSvg;
    parts.caption = el('div', 'wt-caption');
    parts.caption.innerHTML = '<div class="eyebrow"></div><div class="text"></div>';
    parts.keys = el('div', 'wt-keys');
    parts.toasts = el('div', 'wt-toasts');
    root.append(parts.toasts, parts.caption, parts.keys, parts.card, parts.cursor);
    (document.body ?? document.documentElement).append(root);
  };
  /** The 3D view when there is one, else the window: captions and keycaps centre on it. */
  const stage = () => {
    const host = document.querySelector('.canvas-host');
    const r = host?.getBoundingClientRect();
    return r && r.width > 200 ? r : { left: 0, width: innerWidth, bottom: innerHeight };
  };
  const centre = (node) => {
    const s = stage();
    node.style.left = `${s.left + s.width / 2}px`;
    node.style.maxWidth = `${Math.min(940, s.width - 48)}px`;
  };
  let pos = null;
  const moveCursor = (x, y) => {
    mount();
    pos = { x, y };
    parts.cursor.classList.add('on');
    parts.cursor.style.transform = `translate(${x - 3}px,${y - 3}px)`;
  };
  addEventListener('pointermove', (e) => moveCursor(e.clientX, e.clientY), true);
  addEventListener('mousemove', (e) => moveCursor(e.clientX, e.clientY), true);
  addEventListener(
    'pointerdown',
    (e) => {
      moveCursor(e.clientX, e.clientY);
      parts.cursor.classList.add('down');
      const r = el('div', null, 'wt-ripple');
      r.style.left = `${e.clientX}px`;
      r.style.top = `${e.clientY}px`;
      root.insertBefore(r, parts.cursor);
      setTimeout(() => r.remove(), 700);
    },
    true,
  );
  addEventListener('pointerup', () => parts.cursor?.classList.remove('down'), true);
  const timers = {};
  const later = (key, ms, fn) => {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(fn, ms);
  };
  window.__wt = {
    cursor(x, y) {
      moveCursor(x, y);
    },
    caption(text, eyebrow, ms) {
      mount();
      parts.caption.querySelector('.eyebrow').textContent = eyebrow ?? '';
      parts.caption.querySelector('.text').textContent = text;
      centre(parts.caption);
      parts.caption.classList.add('on');
      later('caption', ms, () => parts.caption.classList.remove('on'));
    },
    keys(label, what, ms = 1900) {
      mount();
      parts.keys.innerHTML = '';
      label.split(' + ').forEach((k, i) => {
        if (i) parts.keys.append('+');
        const kbd = el('kbd');
        kbd.textContent = k;
        parts.keys.append(kbd);
      });
      if (what) {
        const w = el('span', null, 'what');
        w.textContent = what;
        parts.keys.append(w);
      }
      const s = stage();
      parts.keys.style.left = `${s.left + s.width / 2}px`;
      parts.keys.classList.add('on');
      later('keys', ms, () => parts.keys.classList.remove('on'));
    },
    toast(ok, text, ms = 2600) {
      mount();
      const t = el('div', null, `wt-toast ${ok ? 'ok' : 'bad'}`);
      t.innerHTML = `<div class="mark">${ok ? '✓' : '✕'}</div><div><div class="tag">${ok ? 'Checked' : 'Check failed'}</div><div class="label"></div></div>`;
      t.querySelector('.label').textContent = text;
      parts.toasts.append(t);
      while (parts.toasts.children.length > 3) parts.toasts.firstChild.remove();
      setTimeout(() => t.classList.add('out'), ok ? ms : ms * 2);
      setTimeout(() => t.remove(), (ok ? ms : ms * 2) + 400);
    },
    ring(box, ms = 1200) {
      mount();
      const r = el('div', null, 'wt-ring');
      const pad = 5;
      Object.assign(r.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + 2 * pad}px`, height: `${box.height + 2 * pad}px` });
      root.insertBefore(r, parts.toasts);
      setTimeout(() => r.remove(), ms);
    },
    card({ kind = 'title', eyebrow = '', title = '', body = '', bullets = [], checks = [], foot = '' }) {
      mount();
      const c = parts.card;
      c.className = kind === 'error' ? 'error' : '';
      c.innerHTML = `<div class="inner"><div class="eyebrow"></div><div class="h1"></div><p></p>${bullets.length ? '<ul></ul>' : ''}${checks.length ? '<ul class="checks"></ul>' : ''}${foot ? '<div class="foot"></div>' : ''}</div><div class="brand">Dental CAD <span>· walkthrough</span></div>`;
      c.querySelector('.eyebrow').textContent = eyebrow;
      c.querySelector('.h1').textContent = title;
      c.querySelector('p').textContent = body;
      for (const k of checks) {
        const li = el('li', null, k.ok ? '' : 'bad');
        li.textContent = k.label;
        c.querySelector('ul.checks').append(li);
      }
      const ul = c.querySelector('ul:not(.checks)');
      for (const b of bullets) {
        const li = el('li');
        li.textContent = b;
        ul.append(li);
      }
      if (foot) c.querySelector('.foot').textContent = foot;
      requestAnimationFrame(() => c.classList.add('on'));
    },
    hideCard() {
      parts.card?.classList.remove('on');
    },
    get pos() {
      return pos;
    },
  };
  if (document.body) mount();
  else addEventListener('DOMContentLoaded', mount, { once: true });
}
