export function formatClockDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(hours > 0 ? 2 : 1, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
