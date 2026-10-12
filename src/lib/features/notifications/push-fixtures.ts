import type { PushNotification } from './push-payload';

export function pushNotification(fields: Partial<PushNotification>): PushNotification {
  return {
    user_id: null,
    room_id: null,
    event_id: null,
    room_name: null,
    sender_display_name: null,
    type: null,
    membership: null,
    content: { body: null, membership: null, notification_type: null },
    unread: null,
    icon: null,
    decrypted: false,
    noisy: false,
    ...fields,
  };
}
