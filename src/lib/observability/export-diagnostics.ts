import { collectSystemInfo } from '#lib/platform/diagnostics.js';
import { savesNatively, saveFile, type SaveOutcome } from '#lib/platform/files.js';

import { buildDiagnosticsBundle } from './diagnostics-bundle.js';
import type { DebugLogEntry } from './debug-log.svelte.js';

export async function exportDiagnosticsBundle(
  entries: readonly DebugLogEntry[]
): Promise<SaveOutcome> {
  const systemInfo = await collectSystemInfo();
  const bundle = buildDiagnosticsBundle(entries, systemInfo);
  const filename = `sable-diagnostics-${String(Date.now())}.json`;
  const url = URL.createObjectURL(new Blob([bundle], { type: 'application/json' }));

  try {
    if (savesNatively()) return await saveFile(url, filename);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    return 'saved';
  } finally {
    URL.revokeObjectURL(url);
  }
}
