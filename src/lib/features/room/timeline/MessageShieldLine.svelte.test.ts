// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import MessageShieldLine from './MessageShieldLine.svelte';

test('a critical shield names the problem and reads as a warning', () => {
  render(MessageShieldLine, { shield: { code: 'sent_in_clear', critical: true } });
  const line = screen.getByText('Not encrypted.').closest('p');
  expect(line?.classList.contains('critical')).toBe(true);
});

test('a grey shield is not styled as critical', () => {
  render(MessageShieldLine, {
    shield: { code: 'authenticity_not_guaranteed', critical: false },
  });
  const line = screen
    .getByText("The authenticity of this encrypted message can't be guaranteed on this device.")
    .closest('p');
  expect(line?.classList.contains('critical')).toBe(false);
});
