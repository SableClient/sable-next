import { describe, expect, test } from 'vitest';
import { furthestReachableStage, stageIndexForPath, type AuthStage } from './stageRegistry';

const stages: readonly AuthStage[] = [
  {
    route: '/login',
    completed: true,
    accessibilityLabel: 'Login',
  },
  {
    route: '/register',
    completed: false,
    accessibilityLabel: 'Register',
  },
  {
    route: '/register/recovery',
    completed: false,
    accessibilityLabel: 'Recovery',
  },
  {
    route: '/register/profile',
    completed: false,
    accessibilityLabel: 'Profile',
  },
];

describe('auth stage registry', () => {
  test('prefers the most specific route', () => {
    expect(stageIndexForPath('/register/recovery', stages)).toBe(2);
    expect(stageIndexForPath('/register/profile', stages)).toBe(3);
  });

  test('clamps a URL to the first unfinished stage', () => {
    expect(furthestReachableStage(3, stages)).toBe(1);
    expect(
      furthestReachableStage(
        3,
        stages.map((stage, index) => ({ ...stage, completed: index < 3 }))
      )
    ).toBe(3);
  });
});
