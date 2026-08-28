export interface RoomWidget {
  id: string;
  type: string;
  url: string;
  name: string;
  data: Record<string, unknown>;
}

export function parseRoomWidget(stateKey: string, content: unknown): RoomWidget | null {
  if (stateKey === '' || typeof content !== 'object' || content === null) return null;

  const record = content as Record<string, unknown>;
  const type = record.type;
  const url = record.url;
  if (typeof type !== 'string' || type === '' || typeof url !== 'string' || url === '') {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;

  const name = typeof record.name === 'string' && record.name !== '' ? record.name : 'Widget';
  const data =
    typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};

  return { id: stateKey, type, url, name, data };
}
