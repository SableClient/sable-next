import { describe, expect, test } from 'vitest';
import { furthestReachableStage, stageIndexForPath, type AuthStage } from './stageRegistry';

const stages: readonly AuthStage[] = [
  {
    route: '/login',
    title: 'Login',
    completed: true,
    accessibilityLabel: 'Login',
  },
  {
    route: '/register',
    title: 'Register',
    completed: false,
    accessibilityLabel: 'Register',
  },
  {
    route: '/register/profile',
    title: 'Profile',
    completed: false,
    accessibilityLabel: 'Profile',
  },
];

describe('auth stage registry', () => {
  test('prefers the most specific route', () => {
    expect(stageIndexForPath('/register/profile', stages)).toBe(2);
  });

  test('clamps a URL to the first unfinished stage', () => {
    expect(furthestReachableStage(2, stages)).toBe(1);
    expect(
      furthestReachableStage(
        2,
        stages.map((stage, index) => ({ ...stage, completed: index < 2 }))
      )
    ).toBe(2);
  });
});
