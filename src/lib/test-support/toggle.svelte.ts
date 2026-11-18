export function reactiveToggle(initial = true): { on: boolean } {
  let on = $state(initial);
  return {
    get on() {
      return on;
    },
    set on(value) {
      on = value;
    },
  };
}
