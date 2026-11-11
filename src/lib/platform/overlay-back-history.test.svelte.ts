export const pageStub = $state<{ state: App.PageState }>({ state: {} });

let stack: App.PageState[] = [{}];

export function goto(_url: string, options: { state: App.PageState }): Promise<void> {
  stack.push(options.state);
  pageStub.state = options.state;
  return Promise.resolve();
}

export function navigate(url: string): void {
  window.history.pushState({}, '', url);
  stack.push({});
  pageStub.state = {};
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
  pageStub.state = {};
}
