const FIRST_ROOM_TIMEOUT_MS = 5000;

let settled = false;
let release = () => {};

export const firstRoomSettled = new Promise<void>((resolve) => {
  release = resolve;
  setTimeout(settleFirstRoom, FIRST_ROOM_TIMEOUT_MS);
});

export function settleFirstRoom(): void {
  settled = true;
  release();
}

export function isFirstRoomSettled(): boolean {
  return settled;
}
