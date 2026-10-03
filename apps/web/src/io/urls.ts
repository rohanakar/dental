/**
 * The app may be served under a sub-path (e.g. https://example.com/dental/)
 * or at the root. Every API and asset URL is built from Vite's BASE_URL,
 * which always ends with "/". Never hardcode absolute paths.
 */
export const BASE_URL: string = import.meta.env.BASE_URL;

const trimLeadingSlashes = (path: string): string => path.replace(/^\/+/, '');

/** apiUrl('cases') → `${BASE_URL}api/cases` (e.g. /dental/api/cases). */
export function apiUrl(path: string): string {
  return `${BASE_URL}api/${trimLeadingSlashes(path)}`;
}

/** URL for a file in /public, e.g. assetUrl('library/36.json'). */
export function assetUrl(path: string): string {
  return `${BASE_URL}${trimLeadingSlashes(path)}`;
}
