import { createContext } from 'svelte';

export class PageMeta {
  title: string = '';
}

export const [usePageMeta, providePageMeta, hasPageMeta] = createContext<PageMeta>();
