import { isCoreError } from '#src/transport';
import { t } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

export async function sendReport(send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
    toasts.info(t('timeline.reportSent'));
  } catch (error) {
    console.warn('[sable report] could not send the report', error);
    const unsupported = isCoreError(error, 'unsupported');
    toasts.error(t(unsupported ? 'timeline.reportUnsupported' : 'errors.actionFailed'));
  }
}
