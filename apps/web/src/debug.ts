/**
 * Dev-only hook for browser tests and debugging: `window.__dcad.<key>`.
 * Stripped from production builds (import.meta.env.DEV is false there).
 */
export function exposeForDebug(key: string, value: unknown): void {
  if (!import.meta.env.DEV) return;
  const w = globalThis as { __dcad?: Record<string, unknown> };
  w.__dcad = { ...w.__dcad, [key]: value };
}
