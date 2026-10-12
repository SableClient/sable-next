import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';

type RowFields = Pick<TimelineItemView, 'row' | 'forwardable' | 'redactable' | 'visibility'>;

const MESSAGE_KINDS: readonly string[] = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'sticker',
  'gallery',
  'location',
  'live_location',
  'poll',
  'redacted',
];
const ANNOTATION_KINDS: readonly string[] = ['date_divider', 'read_marker', 'timeline_start'];
const FORWARDABLE_KINDS: readonly string[] = [
  'message',
  'image',
  'video',
  'audio',
  'file',
  'location',
  'gallery',
];

function visibility(content: TimelineItemContentView): TimelineItemView['visibility'] {
  switch (content.kind) {
    case 'membership':
      return content.change === 'other' ? 'membership_other' : 'membership';
    case 'profile_change':
      return 'profile_change';
    case 'redacted':
      return 'tombstone';
    case 'state_event':
      return content.change === null ? 'hidden' : 'always';
    case 'hidden_event':
      return 'hidden';
    default:
      return 'always';
  }
}

/** What the core sets from the content kind, for items a test builds by hand. */
export function rowFields(content: TimelineItemContentView): RowFields {
  const row = MESSAGE_KINDS.includes(content.kind)
    ? 'message'
    : ANNOTATION_KINDS.includes(content.kind)
      ? 'annotation'
      : 'event';
  return {
    row,
    forwardable: FORWARDABLE_KINDS.includes(content.kind),
    redactable: row !== 'annotation' && content.kind !== 'redacted',
    visibility: visibility(content),
  };
}

export function withRowFields<T extends Omit<TimelineItemView, keyof RowFields>>(
  item: T
): T & RowFields {
  return { ...item, ...rowFields(item.content) };
}
