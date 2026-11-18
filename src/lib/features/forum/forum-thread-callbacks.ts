import type { ForumThread } from './forum-threads';

export interface ForumThreadCallbacks {
  onOpen: (eventId: string) => void;
  onEdit?: (thread: ForumThread) => void;
  onDelete: (eventId: string, reason: string | null) => void;
  onReact?: (eventId: string, key: string) => void;
  onCopyLink: (eventId: string, format?: 'matrix' | 'external') => void;
  onPin?: (eventId: string) => void;
}
