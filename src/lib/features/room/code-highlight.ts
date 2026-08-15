/**
 * Grammar wasm is fetched from arborium's CDN on first use of a language.
 * Anything unknown or unreachable degrades to plain text.
 */
// Bundled, not fetched: base carries the light/dark switch and themes are ~2 KB.
import '@arborium/arborium/themes/base.css';
import '@arborium/arborium/themes/github-light.css';
import '@arborium/arborium/themes/dracula.css';

type ArboriumModule = typeof import('@arborium/arborium');

/** Aliases senders write that arborium does not know under that name. */
const LANGUAGE_ALIASES: Record<string, string> = {
  jsx: 'tsx',
  markup: 'html',
};

let modulePromise: Promise<ArboriumModule | null> | null = null;

async function loadArborium(): Promise<ArboriumModule | null> {
  modulePromise ??= import('@arborium/arborium').catch((error: unknown) => {
    console.debug('[sable code] highlighter unavailable', error);
    return null;
  });
  return modulePromise;
}

/** `null` means the caller keeps the plain text it already has. */
export async function highlightCode(code: string, language: string): Promise<string | null> {
  const requested = LANGUAGE_ALIASES[language.toLowerCase()] ?? language;
  const arborium = await loadArborium();
  if (!arborium) return null;

  try {
    const resolved = arborium.normalizeLanguage(requested);
    if (!(await arborium.isLanguageAvailable(resolved))) return null;
    const html = await arborium.highlight(resolved, code);
    // A grammar that matched nothing returns the source escaped and unwrapped.
    return html.includes('<') ? html : null;
  } catch (error) {
    console.debug('[sable code] highlight failed', language, error);
    return null;
  }
}
