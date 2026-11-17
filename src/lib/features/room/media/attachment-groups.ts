import type { RoomAttachmentView } from '#src/generated/protocol';
import { currentLocale } from '#lib/i18n.js';

export interface AttachmentGroup<T extends RoomAttachmentView> {
  key: string;
  label: string;
  items: T[];
}

export function groupByMonth<T extends RoomAttachmentView>(
  items: readonly T[]
): AttachmentGroup<T>[] {
  const groups: AttachmentGroup<T>[] = [];
  const locale = currentLocale();
  const now = new Date();
  for (const item of items) {
    const date = new Date(item.timestamp);
    const key = `${String(date.getFullYear())}-${String(date.getMonth())}`;
    const last = groups.at(-1);
    if (last?.key === key) {
      last.items.push(item);
      continue;
    }
    groups.push({
      key,
      label: date.toLocaleDateString(locale, {
        month: 'long',
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
      }),
      items: [item],
    });
  }
  return groups;
}
