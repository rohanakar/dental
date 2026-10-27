import { useDesignStore } from '../design/store';
import type { MarginLineKind } from '../geometry/livewire';
import { useToolStore } from './toolStore';

/**
 * The line a tooth's margin follows (specs/2026-10-27-natural-margin.md): the user's choice in the Margin step, else
 * the margin's own line, else a prep's finish line. Drawing and editing use the matching live-wire.
 */
export function marginLineOf(fdi: number): MarginLineKind {
  const chosen = useToolStore.getState().marginLine[fdi];
  if (chosen) return chosen;
  return useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi)?.margin?.line ?? 'finish';
}

/** A cheap key for a margin's points: the doubt checks of a gum line apply while its points are unchanged. */
export function marginKey(points: ReadonlyArray<{ p: readonly number[] }>): string {
  const r = (x: number | undefined) => Math.round((x ?? 0) * 1000);
  const a = points[0]?.p, b = points.at(-1)?.p, m = points[Math.floor(points.length / 2)]?.p;
  return [points.length, ...[a, m, b].flatMap((p) => [r(p?.[0]), r(p?.[1]), r(p?.[2])])].join(':');
}
