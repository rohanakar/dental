import type { ScanRole } from '@dcad/shared';

export const ACCEPTED_EXTENSIONS = ['.stl', '.ply'];

export const isScanFile = (file: File): boolean =>
  ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));

/** Guess the scan role from common scanner export names; null when unclear. */
export function roleFromFileName(name: string): ScanRole | null {
  const n = name.toLowerCase();
  if (/pre-?op/.test(n)) return 'preop';
  if (/upper|maxill|oberkiefer|\bub\b|_u\b/.test(n)) return 'upper';
  if (/lower|mandib|unterkiefer|\blb\b|_l\b/.test(n)) return 'lower';
  return null;
}

/**
 * Assign roles to dropped files: names win; remaining files take the
 * selected role first, then the other jaw.
 */
export function assignRoles(files: File[], preferred: ScanRole): Array<{ file: File; role: ScanRole }> {
  const used = new Set<ScanRole>();
  const out: Array<{ file: File; role: ScanRole }> = [];
  const pending: File[] = [];
  for (const file of files) {
    const role = roleFromFileName(file.name);
    if (role && !used.has(role)) {
      used.add(role);
      out.push({ file, role });
    } else {
      pending.push(file);
    }
  }
  const order: ScanRole[] = [preferred, ...(['lower', 'upper', 'preop'] as const).filter((r) => r !== preferred)];
  for (const file of pending) {
    const role = order.find((r) => !used.has(r));
    if (!role) break;
    used.add(role);
    out.push({ file, role });
  }
  return out;
}
