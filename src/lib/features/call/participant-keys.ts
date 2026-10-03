export function participantKeys(userIds: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return userIds.map((userId) => {
    const count = seen.get(userId) ?? 0;
    seen.set(userId, count + 1);
    return count === 0 ? userId : `${userId}#${String(count)}`;
  });
}

export function numberedName(name: string, key: string): string {
  const copy = key.match(/#(\d+)$/)?.[1];
  return copy === undefined ? name : `${name} (${String(Number(copy) + 1)})`;
}
