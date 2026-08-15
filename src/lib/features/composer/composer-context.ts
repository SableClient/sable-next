export interface ComposerContext {
  kind: 'reply' | 'edit';
  eventId: string;
  sender?: string | null;
  body: string;
}
