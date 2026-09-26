import { createContext } from 'svelte';

export const [useSenderRoleIcons, provideSenderRoleIcons, hasSenderRoleIcons] =
  createContext<(userId: string) => string | null>();
