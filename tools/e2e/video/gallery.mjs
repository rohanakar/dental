// The gallery page for out/videos/: the episode list, a player with the episode's chapters (click to seek) and the
// checks it ran. Self-contained HTML; the videos sit next to it.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function gallery(report) {
  const eps = report.episodes;
  const seconds = eps.reduce((a, e) => a + e.seconds, 0);
  const checks = eps.flatMap((e) => e.checks);
  const passed = checks.filter((c) => c.ok).length;
  const data = JSON.stringify(eps).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dental CAD walkthroughs</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#14181f;--muted:#5d6878;--line:#e3e7ee;--accent:#3a6fd8;--accent-soft:#e8effc;--ok:#1f8a4c;--bad:#c62f36;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--panel:#191d23;--ink:#e9edf3;--muted:#98a3b3;--line:#2a3039;--accent:#7aa2f7;--accent-soft:#1e2a40;--ok:#4cc27e;--bad:#ff6b72;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{padding:28px 32px 8px;max-width:1440px;margin:0 auto}
header h1{margin:0;font-size:26px;letter-spacing:-.01em}
header p{margin:6px 0 0;color:var(--muted)}
.stats{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:12px;font-size:14px;color:var(--muted)}
.stats b{color:var(--ink);font-variant-numeric:tabular-nums}
main{display:grid;grid-template-columns:320px 1fr;gap:24px;padding:18px 32px 48px;max-width:1440px;margin:0 auto}
nav{display:flex;flex-direction:column;gap:6px;align-self:start;position:sticky;top:16px}
nav a{display:grid;grid-template-columns:30px 1fr auto;gap:8px;align-items:center;text-decoration:none;color:inherit;padding:10px 12px;border-radius:10px;border:1px solid transparent}
nav a:hover{background:var(--panel);border-color:var(--line)}
nav a.on{background:var(--panel);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
nav .n{font:600 13px ui-monospace,Menlo,monospace;color:var(--muted)}
nav .t{font-weight:560;line-height:1.3}
nav .d{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
nav .d .s{display:block;font-weight:650}
.ok{color:var(--ok)}.bad{color:var(--bad)}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;min-width:0}
video{display:block;width:100%;aspect-ratio:16/9;background:#000}
.body{padding:20px 24px 26px}
.body h2{margin:0 0 4px;font-size:22px}
.body .sum{margin:0;color:var(--muted);max-width:820px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:20px}
h3{font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.chapters{list-style:none;margin:0;padding:0}
.chapters button{all:unset;cursor:pointer;display:grid;grid-template-columns:52px 1fr;gap:8px;width:100%;padding:6px 8px;border-radius:7px}
.chapters button:hover,.chapters button:focus-visible{background:var(--accent-soft)}
.chapters .at{font:500 13px ui-monospace,Menlo,monospace;color:var(--accent);padding-top:1px}
.checks{list-style:none;margin:0;padding:0;font-size:14px}
.checks li{display:grid;grid-template-columns:20px 1fr;gap:6px;padding:4px 0;border-bottom:1px solid var(--line)}
.checks li:last-child{border-bottom:0}
.checks .detail{display:block;color:var(--muted);font-size:12.5px;word-break:break-word}
.error{margin-top:16px;padding:12px 14px;border-radius:10px;background:color-mix(in srgb,var(--bad) 12%,transparent);color:var(--bad);font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
@media (max-width:900px){main{grid-template-columns:1fr;padding:12px 16px 40px}header{padding:20px 16px 4px}nav{position:static}.cols{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>Dental CAD walkthroughs</h1>
  <p>Each video drives the real app and checks what it shows. A ✕ in a video or below it is a failed check.</p>
  <div class="stats"><span><b>${eps.length}</b> episode${eps.length === 1 ? '' : 's'}</span><span><b>${clock(seconds)}</b> in all</span><span><b class="${passed === checks.length ? 'ok' : 'bad'}">${passed}/${checks.length}</b> checks passed</span><span>Filmed ${esc(new Date(report.filmed).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
</header>
<main>
  <nav aria-label="Episodes">${eps
    .map((e) => {
      const p = e.checks.filter((c) => c.ok).length;
      return `<a href="#${esc(e.id)}" data-id="${esc(e.id)}"><span class="n">${String(e.number).padStart(2, '0')}</span><span class="t">${esc(e.title)}</span><span class="d">${clock(e.seconds)}<span class="s ${e.ok ? 'ok' : 'bad'}">${e.error ? 'stopped' : `${p}/${e.checks.length} ✓`}</span></span></a>`;
    })
    .join('')}</nav>
  <section aria-live="polite">
    <video id="player" controls preload="metadata" playsinline></video>
    <div class="body">
      <h2 id="title"></h2>
      <p class="sum" id="summary"></p>
      <div class="cols">
        <div><h3>Chapters</h3><ul class="chapters" id="chapters"></ul></div>
        <div><h3 id="checks-head">Checks</h3><ul class="checks" id="checks"></ul></div>
      </div>
      <div class="error" id="error" hidden></div>
    </div>
  </section>
</main>
<script>
const EPISODES = ${data};
const player = document.getElementById('player');
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function show(id, play) {
  const e = EPISODES.find((x) => x.id === id) || EPISODES[0];
  if (!e) return;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.id === e.id));
  player.src = e.video;
  player.innerHTML = '<track kind="subtitles" srclang="en" label="English" src="' + e.subtitles + '">';
  document.getElementById('title').textContent = String(e.number).padStart(2, '0') + ' · ' + e.title;
  document.getElementById('summary').textContent = e.summary;
  const ch = document.getElementById('chapters');
  ch.replaceChildren(...e.chapters.map((c) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = '<span class="at"></span><span></span>';
    b.firstChild.textContent = clock(c.t);
    b.lastChild.textContent = c.title;
    b.onclick = () => { player.currentTime = c.t; player.play(); };
    li.append(b);
    return li;
  }));
  const passed = e.checks.filter((c) => c.ok).length;
  document.getElementById('checks-head').textContent = 'Checks · ' + passed + '/' + e.checks.length + ' passed';
  document.getElementById('checks').replaceChildren(...e.checks.map((c) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span><span class="label"></span><span class="detail"></span></span>';
    li.firstChild.textContent = c.ok ? '✓' : '✕';
    li.firstChild.className = c.ok ? 'ok' : 'bad';
    li.querySelector('.label').textContent = c.label;
    if (!c.ok && c.detail) li.querySelector('.detail').textContent = c.detail;
    return li;
  }));
  const err = document.getElementById('error');
  err.hidden = !e.error;
  err.textContent = e.error || '';
  if (play) player.play().catch(() => {});
}
addEventListener('hashchange', () => show(location.hash.slice(1), true));
player.addEventListener('ended', () => {
  const i = EPISODES.findIndex((x) => player.src.endsWith(x.video));
  if (EPISODES[i + 1]) location.hash = EPISODES[i + 1].id;
});
show(location.hash.slice(1), false);
</script>
</body>
</html>
`;
}
