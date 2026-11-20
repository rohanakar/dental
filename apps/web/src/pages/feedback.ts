import { applyContact } from '../site';

applyContact();

const form = document.querySelector<HTMLFormElement>('#feedback-form')!;
const error = form.querySelector<HTMLElement>('.form-error')!;
const ok = form.querySelector<HTMLElement>('.form-ok')!;
const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const from = new URLSearchParams(location.search).get('from') ?? 'site';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = ok.hidden = true;
  const data = new FormData(form);
  const message = String(data.get('message') ?? '').trim();
  if (!message) {
    error.textContent = 'Write a few words first.';
    error.hidden = false;
    return;
  }
  button.disabled = true;
  try {
    const res = await fetch('../api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message, email: String(data.get('email') ?? ''), page: from.slice(0, 40) }),
    });
    if (res.status === 429) throw new Error('Too much feedback from this address for now. Please email us instead.');
    if (res.status === 400) throw new Error('Check the message and the email address.');
    if (!res.ok) throw new Error('It could not be sent. Please email us instead.');
    form.reset();
    ok.hidden = false;
  } catch (e) {
    error.textContent = e instanceof Error && e.message !== 'Failed to fetch' ? e.message : 'It could not be sent. Please email us instead.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});
