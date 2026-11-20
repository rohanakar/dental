/**
 * Who to contact. The address defaults to the beta's feedback inbox; VITE_CONTACT_EMAIL overrides it at build time,
 * and VITE_CONTACT_NAME adds a "Built by" line (left out when unset). There is no booking link: people write.
 */
const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export const CONTACT_EMAIL = clean(import.meta.env.VITE_CONTACT_EMAIL) || 'rohanakar@gmail.com';
export const CONTACT_NAME = clean(import.meta.env.VITE_CONTACT_NAME);
export const feedbackHref = (subject = 'Dental CAD feedback'): string =>
  CONTACT_EMAIL ? `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}` : '';

/** The feedback page, from the editor (`app/`) or the demo; relative to the app's own URL. */
export const feedbackLinkHref = (from: 'editor' | 'demo'): string => `../feedback/?from=${from}`;

/**
 * Fills the static pages' contact elements, so the address is not in the HTML source:
 * `[data-contact-email]` (href + text), `[data-contact-name]` (text), and hides the
 * `[data-needs-email]` / `[data-needs-name]` blocks whose setting is empty.
 */
export function applyContact(root: ParentNode = document): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-contact-email]')) {
    a.href = feedbackHref(a.dataset.subject);
    a.textContent = CONTACT_EMAIL;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-contact-name]')) el.textContent = CONTACT_NAME;
  const hide = (selector: string, unset: boolean) => {
    if (unset) for (const el of root.querySelectorAll<HTMLElement>(selector)) el.hidden = true;
  };
  hide('[data-needs-email]', !CONTACT_EMAIL);
  hide('[data-needs-name]', !CONTACT_NAME);
}

/** Shown in the editor, the new-case form, the landing page and the privacy page. */
export const DATA_RULE =
  'Beta: cases are stored on our server for your lab, so upload anonymised scans only. Rename the files: an STL holds no patient details itself.';
