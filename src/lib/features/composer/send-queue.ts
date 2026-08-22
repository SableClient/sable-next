export type SendOperation<T> = (isLive: () => boolean) => Promise<T>;

export class SendQueue {
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  private live = (): boolean => !this.disposed;

  enqueue<T>(operation: SendOperation<T>): Promise<T | undefined> {
    const result = this.tail.then(() => (this.disposed ? undefined : operation(this.live)));
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  dispose(): void {
    this.disposed = true;
  }
}
