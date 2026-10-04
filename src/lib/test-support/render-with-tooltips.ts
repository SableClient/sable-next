import { render } from '@testing-library/svelte';
import type { Component } from 'svelte';

import WithTooltips from './WithTooltips.test.svelte';

export function renderWithTooltips(component: Component<never>, options: Record<string, unknown>) {
  const props = 'props' in options ? (options.props as Record<string, unknown>) : options;
  return render(WithTooltips, { props: { component, props } });
}
