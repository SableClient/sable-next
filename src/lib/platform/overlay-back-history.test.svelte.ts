export const pageStub = $state<{ state: App.PageState }>({ state: {} });

let stack: App.PageState[] = [{}];
let landing: Promise<void> | null = null;

export function holdNextEntry(): () => void {
  let release!: () => void;
  landing = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

export function goto(_url: string, options: { state: App.PageState }): Promise<void> {
  stack.push(options.state);
  pageStub.state = options.state;
  const landed = landing ?? Promise.resolve();
  landing = null;
  return landed;
}

export function navigate(url: string, state: App.PageState = {}): void {
  window.history.pushState({}, '', url);
  stack.push(state);
  pageStub.state = state;
}

export function go(delta?: number): void {
  stack = stack.slice(0, Math.max(1, stack.length + (delta ?? 0)));
  pageStub.state = stack[stack.length - 1];
}

export function entries(): number {
  return stack.length;
}

export function reset(): void {
  window.history.replaceState({}, '', '/');
  stack = [{}];
  landing = null;
  pageStub.state = {};
}
