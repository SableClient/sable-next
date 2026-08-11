import { redirect } from '@sveltejs/kit';

import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  let target = `/home/${params.roomId}`;
  if (params.eventId) target += `/${params.eventId}`;
  return redirect(307, target);
};
