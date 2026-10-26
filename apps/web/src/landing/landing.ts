/**
 * Landing page behaviour, kept free of React and editor code so the page stays light:
 * - the sign-up form posts to Better Auth's email endpoint (same origin, so the session cookie is set) and then
 *   opens the editor;
 * - a visitor who already has a session sees "Open your cases" instead of the form;
 * - the checks panel runs its five gates once on load.
 * URLs are relative, so the page works at the domain root and under a sub-path.
 */

const AUTH = 'api/auth';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showSession(state: 'signed-in' | 'signed-out'): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-session]')) el.hidden = el.dataset.session !== state;
}

async function checkSession(): Promise<void> {
  try {
    const res = await fetch(`${AUTH}/get-session`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as { user?: { email?: string } } | null;
    if (!data?.user) return;
    showSession('signed-in');
    const email = document.querySelector('[data-user-email]');
    if (email && data.user.email) email.textContent = ` as ${data.user.email}`;
  } catch {
    // No API (offline preview, server down): the page stays as it is.
  }
}

type Failure = { text: string; link?: { href: string; label: string }; field?: HTMLInputElement };

function setupSignup(form: HTMLFormElement): void {
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const name = input('name');
  const email = input('email');
  const password = input('password');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const error = form.querySelector<HTMLElement>('.form-error')!;

  const clear = () => {
    error.hidden = true;
    error.replaceChildren();
    for (const field of [name, email, password]) field.removeAttribute('aria-invalid');
  };
  const fail = ({ text, link, field }: Failure) => {
    error.replaceChildren(text);
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      error.append(' ', a);
    }
    error.hidden = false;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  };
  const unreachable: Failure = {
    text: "We can't reach the server right now. Try again in a minute, or",
    link: { href: 'app/?demo', label: 'open the demo case, which needs no account.' },
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear();
    const body = { name: name.value.trim(), email: email.value.trim(), password: password.value };
    if (!body.name) return fail({ text: 'Enter your name.', field: name });
    if (!body.email || !email.validity.valid) return fail({ text: 'Enter a valid work email.', field: email });
    if (body.password.length < 10) return fail({ text: 'Use a password of at least 10 characters.', field: password });

    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = 'Creating your lab…';
    try {
      const res = await fetch(`${AUTH}/sign-up/email`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        window.location.assign('app/');
        return;
      }
      if (res.status >= 500 || res.status === 404) return fail(unreachable);
      const { code = '', message = '' } = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      if (code.includes('ALREADY_EXISTS')) {
        return fail({ text: 'An account with this email already exists.', link: { href: 'app/', label: 'Sign in instead.' }, field: email });
      }
      if (code.includes('PASSWORD')) return fail({ text: message || 'Choose a different password.', field: password });
      if (code.includes('EMAIL')) return fail({ text: 'Enter a valid work email.', field: email });
      return fail({ text: message || 'The account could not be created. Try again.' });
    } catch {
      return fail(unreachable);
    } finally {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      button.textContent = 'Create lab account';
    }
  });

  // "Create lab account" links elsewhere on the page bring the form into view and start it.
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-focus-signup]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      form.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      name.focus({ preventScroll: true });
    });
  }
}

/**
 * The checks run top to bottom, the way auto-design runs its gates; the page's one authored moment. Each value
 * settles from its gate threshold to the measured result, and a row passes only when its value lands.
 */
function runChecks(panel: HTMLElement): void {
  if (reducedMotion) return;
  const rows = [...panel.querySelectorAll<HTMLElement>('[data-check]')];
  const passed = panel.querySelector<HTMLElement>('[data-passed]');
  const format = (el: HTMLElement, v: number) => (el.textContent = v.toFixed(Number(el.dataset.decimals ?? 0)));
  panel.classList.add('is-running');
  if (passed) passed.textContent = '0';
  for (const row of rows) {
    const value = row.querySelector<HTMLElement>('[data-value]');
    if (value) format(value, Number(value.dataset.from ?? value.dataset.to));
  }
  const step = 360;
  rows.forEach((row, i) => {
    const value = row.querySelector<HTMLElement>('[data-value]');
    const land = () => {
      row.classList.add('is-passed');
      // Rows land out of order when a value takes longer to settle: count them, not the index.
      if (passed) passed.textContent = String(panel.querySelectorAll('[data-check].is-passed').length);
      if (i === rows.length - 1) panel.classList.remove('is-running');
    };
    window.setTimeout(() => (value ? settle(value, land) : land()), 450 + i * step);
  });
}

function settle(el: HTMLElement, done: () => void): void {
  const from = Number(el.dataset.from ?? el.dataset.to);
  const to = Number(el.dataset.to);
  const decimals = Number(el.dataset.decimals ?? 0);
  if (from === to) return done();
  const start = performance.now();
  const duration = 320;
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = t === 1 ? 1 : 1 - 2 ** (-10 * t);
    el.textContent = (from + (to - from) * eased).toFixed(decimals);
    if (t < 1) requestAnimationFrame(frame);
    else done();
  };
  requestAnimationFrame(frame);
}

const form = document.querySelector<HTMLFormElement>('#signup');
if (form) setupSignup(form);
const panel = document.querySelector<HTMLElement>('.checks');
if (panel) runChecks(panel);
void checkSession();
