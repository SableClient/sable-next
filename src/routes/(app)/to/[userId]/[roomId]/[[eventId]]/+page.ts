import { redirect } from '@sveltejs/kit';

import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  const target = `/home/${params.roomId}`;
  const query = params.eventId ? `?event=${encodeURIComponent(params.eventId)}` : '';
  return redirect(307, `${target}${query}`);
};
