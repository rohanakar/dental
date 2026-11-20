import { applyContact, DATA_RULE } from '../site';

for (const el of document.querySelectorAll('[data-data-rule]')) el.textContent = DATA_RULE;
applyContact();
