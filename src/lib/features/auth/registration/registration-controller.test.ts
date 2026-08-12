import { describe, expect, it } from 'vitest';
import {
  hasEmailVerificationToken,
  registrationFieldForStage,
} from './registration-controller.svelte';

describe('registration controller helpers', () => {
  it('preserves opaque email token whitespace while validating only length', () => {
    expect(hasEmailVerificationToken(' code ')).toBe(true);
    expect(hasEmailVerificationToken('')).toBe(false);
    expect(hasEmailVerificationToken('x'.repeat(256))).toBe(false);
  });

  it('maps protocol stages to focused fields', () => {
    expect(registrationFieldForStage('m.login.registration_token')).toBe('registrationToken');
    expect(registrationFieldForStage('m.login.password')).toBe('password');
    expect(registrationFieldForStage('m.login.email.identity')).toBe('email');
  });
});
