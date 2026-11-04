import { applyDeploymentTheme } from '#lib/settings/theme.js';
import { parseThemeFile } from '#lib/settings/theme-file.js';

let generation = 0;

export async function loadDeploymentTheme(url: string | null): Promise<void> {
  const current = ++generation;
  applyDeploymentTheme('');
  if (url === null) return;
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) {
    console.debug('[sable deployment] theme not applied', url, response?.status ?? 'offline');
    return;
  }
  const text = await response.text().catch(() => null);
  if (current !== generation || text === null) return;
  const file = parseThemeFile(text, url);
  if (typeof file === 'string') {
    console.debug('[sable deployment] theme not applied', url, file);
    return;
  }
  applyDeploymentTheme(file.kind === 'theme' ? file.theme.css : file.tweak.css);
}
