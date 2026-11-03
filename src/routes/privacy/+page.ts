import { redirect } from '@sveltejs/kit';

import { deployment } from '#lib/deployment/deployment.js';

import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
  await parent();
  const url = deployment().links.privacy;
  if (url !== null) redirect(307, url);
};
