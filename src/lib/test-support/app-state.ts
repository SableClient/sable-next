interface TestPage {
  url: URL;
  params: Record<string, string>;
  route: { id: string | null };
  state: Record<string, unknown>;
}

const ORIGIN = 'http://localhost';

export const page: TestPage = {
  url: new URL('/', ORIGIN),
  params: {},
  route: { id: null },
  state: {},
};

export function visit(path: string, params: Record<string, string> = {}): void {
  page.url = new URL(path, ORIGIN);
  page.params = params;
}

export function resetPage(): void {
  visit('/');
  page.route = { id: null };
  for (const key of Object.keys(page.state)) Reflect.deleteProperty(page.state, key);
}
