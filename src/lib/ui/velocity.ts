export class Velocity {
  value = 0;
  #last = 0;
  #time = 0;

  reset(position: number, time: number): void {
    this.value = 0;
    this.#last = position;
    this.#time = time;
  }

  track(position: number, time: number): void {
    const elapsed = time - this.#time;
    if (elapsed <= 0) return;
    this.value = (position - this.#last) / elapsed;
    this.#last = position;
    this.#time = time;
  }
}
