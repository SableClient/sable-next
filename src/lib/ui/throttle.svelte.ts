export function throttle<Args extends unknown[]>(func: (...args: Args) => void, delay: number) {
  let ready = true;
  return (...args: Args) => {
    if (!ready) return;
    ready = false;

    func.call(null, ...args);
    setTimeout(() => {
      ready = true;
    }, delay);
  };
}
