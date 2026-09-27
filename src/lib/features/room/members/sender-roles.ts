import { createContext } from 'svelte';

export interface SenderRole {
  icon: string | null;
  color: string | null;
}

export const [useSenderRoles, provideSenderRoles, hasSenderRoles] =
  createContext<(userId: string) => SenderRole | null>();
