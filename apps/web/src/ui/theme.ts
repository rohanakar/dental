import { useEffect } from 'react';
import { create } from 'zustand';

export type Theme = 'light' | 'dark';

const KEY = 'dcad.theme';

/** The saved choice, or light when there is none or storage is unavailable (private window, blocked site data). */
function saved(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * The editor's theme. Every surface is light, as on the landing page; the editor's dark theme is opt-in from the
 * toolbar and remembered per browser.
 */
export const useTheme = create<{ theme: Theme }>(() => ({ theme: saved() }));

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembered; the choice still applies to this visit.
  }
  useTheme.setState({ theme });
}

/** Applies the theme to <html> while the editor is mounted; the session screens around it stay light. */
export function useEditorTheme(): void {
  const theme = useTheme((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.dataset.theme = 'dark';
    else delete root.dataset.theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);
}
