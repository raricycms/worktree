/** The user's theme preference; 'system' follows the OS and is the default. */
export type ThemePref = 'system' | 'light' | 'dark';

export type ResolvedTheme = 'light' | 'dark';

export function isThemePref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light';
  }
  return pref;
}

/**
 * Paint the document in the resolved theme. index.html runs the same
 * resolution inline before first paint, so a stored preference never flashes
 * the wrong theme; this keeps the running app in step with changes.
 */
function paint(pref: ThemePref): void {
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute('content', theme === 'dark' ? '#131517' : '#f8fafc');
}

/** Apply the preference now and, for 'system', whenever the OS preference changes. */
export function watchTheme(pref: ThemePref): () => void {
  paint(pref);
  if (pref !== 'system') return () => undefined;
  const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (mql === undefined) return () => undefined;
  const onChange = (): void => paint(pref);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
