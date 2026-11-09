export interface PresentedAlertData {
  roomId?: unknown;
  userId?: unknown;
  call?: boolean;
  callExpiresAtMs?: number;
}

/** A call alert stays up until its invite expires, even once the room is read. */
export function isRingingCall(data: PresentedAlertData | undefined, now = Date.now()): boolean {
  return data?.call === true && (data.callExpiresAtMs ?? 0) > now;
}
