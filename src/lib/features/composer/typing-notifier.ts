const TYPING_TIMEOUT_MS = 4000;

export class TypingNotifier {
  #timeout: ReturnType<typeof setTimeout> | undefined;
  /** The room the server believes we are typing in, which `roomId()` no longer names once the view is leaving. */
  #typingIn: string | null = null;

  constructor(
    private readonly roomId: () => string,
    private readonly notify: (roomId: string, typing: boolean) => Promise<void>
  ) {}

  update(empty: boolean): void {
    if (empty) {
      this.stop();
      return;
    }

    if (this.#timeout) clearTimeout(this.#timeout);
    const room = this.roomId();
    if (this.#typingIn !== null && this.#typingIn !== room) this.#send(this.#typingIn, false);
    this.#typingIn = room;
    this.#send(room, true);
    this.#timeout = setTimeout(() => {
      this.stop();
    }, TYPING_TIMEOUT_MS);
  }

  stop(): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (this.#typingIn === null) return;
    this.#send(this.#typingIn, false);
    this.#typingIn = null;
  }

  #send(roomId: string, typing: boolean): void {
    this.notify(roomId, typing).catch((error: unknown) => {
      console.debug('[sable composer] typing notification failed', error);
    });
  }
}
