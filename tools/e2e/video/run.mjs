// Films the walkthrough series (specs/2026-10-30-walkthrough-videos.md) against the dev server, then writes the report
// and the gallery to out/videos/.
//
//   pnpm dev:web                                   # terminal 1
//   pnpm --filter @dcad/e2e videos                 # every episode
//   pnpm --filter @dcad/e2e videos 01 04           # some episodes, by number or id
//   pnpm --filter @dcad/e2e videos -- --full       # also join the series into one video
//
// Env: APP_URL (default http://localhost:5173/app/), VIDEO_OUT (default out/videos/), VOICE (default Samantha),
// VOICE_RATE (words a minute, default 182), NARRATION=0 for no audio track, TTS_CACHE (the narration clips, default
// out/.tts-cache/).
// Exits non-zero if a check failed or an episode stopped.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { APP_URL, OUT, film } from './director.mjs';
import { gallery } from './gallery.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const full = args.includes('--full');
const wanted = args.filter((a) => !a.startsWith('--'));
const dir = new URL('./episodes/', import.meta.url);
const all = [];
const broken = new Map();
for (const file of readdirSync(dir).filter((f) => /^\d\d-.*\.mjs$/.test(f)).sort()) {
  const id = file.replace(/\.mjs$/, '');
  try {
    all.push((await import(new URL(file, dir).href)).default);
  } catch (e) {
    // An episode that does not load only matters if it was asked for; the others still film.
    broken.set(id, e);
    all.push({ id, title: id, broken: true });
  }
}
const matches = (e) => !wanted.length || wanted.some((w) => e.id === w || e.id.startsWith(`${w.padStart(2, '0')}-`));
const picked = all.filter(matches);
if (!picked.length) throw new Error(`No episode matches ${wanted.join(' ')}; episodes: ${all.map((e) => e.id).join(', ')}`);
for (const e of picked) if (e.broken) throw broken.get(e.id);

try {
  await fetch(APP_URL);
} catch {
  console.error(`The app is not answering at ${APP_URL}: start it with pnpm dev:web`);
  process.exit(1);
}

const reportFile = `${OUT}report.json`;
const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : { episodes: [] };
const keep = (entry) => {
  report.episodes = [...report.episodes.filter((e) => e.id !== entry.id && all.some((a) => a.id === e.id)), entry].sort((a, b) => a.id.localeCompare(b.id));
  report.filmed = new Date().toISOString();
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${OUT}index.html`, gallery(report));
};

const results = [];
for (const episode of picked) {
  const number = all.indexOf(episode) + 1;
  console.log(`\n=== ${episode.id}: ${episode.title}`);
  const entry = await film(episode, { number, total: all.length, next: all[number] });
  keep(entry);
  results.push(entry);
  const passed = entry.checks.filter((c) => c.ok).length;
  console.log(`=== ${episode.id}: ${entry.ok ? 'ok' : 'FAILED'} · ${passed}/${entry.checks.length} checks · ${entry.seconds} s of video in ${entry.filmedInSeconds} s${entry.error ? ` · stopped: ${entry.error.split('\n')[0]}` : ''}`);
}

if (full) {
  const list = `${OUT}.concat.txt`;
  writeFileSync(list, report.episodes.map((e) => `file '${OUT}${e.video}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', `${OUT}dcad-walkthrough-full.mp4`]);
  console.log(`joined ${report.episodes.length} episodes into ${OUT}dcad-walkthrough-full.mp4`);
}

console.log(`\nGallery: ${OUT}index.html`);
for (const r of results) console.log(`${r.ok ? 'ok    ' : 'FAILED'} ${r.id} (${r.checks.filter((c) => c.ok).length}/${r.checks.length})`);
if (results.some((r) => !r.ok)) process.exit(1);
