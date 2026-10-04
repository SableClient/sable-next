import type { Award } from './award.js';

export const FIXTURE_USER = '@alice:example.org';
export const FIXTURE_KEYS = { '1': '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw' };

export const VALID: Award = {
  signed: {
    content: { body: 'Donor' },
    expires_at: 4102444800,
    id: 'oc-0123456789abcdef',
    sender: '@awards:sable.moe',
    user_id_hash: '86f01aef21b1acd3f7722fa5c5e3ad09f683388edd2fe494435839da18bb166f',
  },
  signatures: {
    '1': '8g1yGNnnhhJ7PXvTq3494ZMrL9tUt4QKgIjnjmaIi0oUdFDSK85KdeyFEaA++NYITEi6EUPO6axhH9uWdISWCQ',
  },
};

export const EXPIRED: Award = {
  signed: {
    content: { body: 'Donor' },
    expires_at: 1000000000,
    id: 'oc-fedcba9876543210',
    sender: '@awards:sable.moe',
    user_id_hash: '86f01aef21b1acd3f7722fa5c5e3ad09f683388edd2fe494435839da18bb166f',
  },
  signatures: {
    '1': 'pX9b73za3G5KH6w27gubrAoJYZ9aaJMiSd8AJv4IXHUamJTz1XRaFdxyowUpNLc7spwctKhgHgIOC/8F0PJzAA',
  },
};

export const PERMANENT: Award = {
  signed: {
    content: { body: 'Donor' },
    id: 'manual-0011223344556677',
    sender: '@awards:sable.moe',
    user_id_hash: '86f01aef21b1acd3f7722fa5c5e3ad09f683388edd2fe494435839da18bb166f',
  },
  signatures: {
    '1': 'zzbvveXrX3K7Dxa3M6du/+F8g4xRkW2KF7DLp7sssDD/wB/w/VL+TozTOVxW0eAD2oWBGjEgQ6Asa7XZ9tVaAQ',
  },
};
