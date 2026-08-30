export interface ConversationLine {
  sender: string | null;
  body: string;
}

export const MAX_CONVERSATION_LINES = 5;

export function appendLine(
  lines: readonly ConversationLine[],
  line: ConversationLine
): ConversationLine[] {
  return [...lines, line].slice(-MAX_CONVERSATION_LINES);
}

export function summarise(lines: readonly ConversationLine[]): string {
  return lines.map(render).join('\n');
}

function render(line: ConversationLine): string {
  return line.sender === null ? line.body : `${line.sender}: ${line.body}`;
}

export function readLines(value: unknown): ConversationLine[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { sender, body } = entry as { sender?: unknown; body?: unknown };
    if (typeof body !== 'string') return [];
    return [{ sender: typeof sender === 'string' ? sender : null, body }];
  });
}
