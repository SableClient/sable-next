import { openExternalAuthUrl } from './external-auth.js';
import { openExternalUrl, opensExternalUrls } from './external-links.js';

/** Native apps open account pages in the system browser, which keeps the account sign-in. */
export function openAccountManagementUrl(url: string): Promise<void> {
  return opensExternalUrls() ? openExternalUrl(url) : openExternalAuthUrl(url);
}
