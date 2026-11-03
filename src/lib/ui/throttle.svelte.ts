/* eslint @typescript-eslint/no-unsafe-function-type: "off", @typescript-eslint/no-explicit-any: "off" */
export function throttle(func: Function, delay: number) {
  let ready = true;
  return (...args: any) => {
    if (!ready) return;
    ready = false;

    func.apply(null, args);
    setTimeout(() => {
      ready = true;
    }, delay);
  };
}
