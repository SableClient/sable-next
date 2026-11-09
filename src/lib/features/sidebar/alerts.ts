import * as DesktopUpdateAlert from '#lib/features/sidebar/DesktopUpdateAlert.svelte';
import * as RecoveryIncompleteAlert from '#lib/features/sidebar/RecoveryIncompleteAlert.svelte';
import * as UnverifiedDeviceAlert from '#lib/features/sidebar/UnverifiedDeviceAlert.svelte';
import * as WebUpdateAlert from '#lib/features/sidebar/WebUpdateAlert.svelte';
import * as SearchIndexTransferAlert from '#lib/features/sidebar/SearchSharingAlert.svelte';
import type { IconComponentProps } from 'phosphor-svelte';
import { createContext, type Component } from 'svelte';
import * as ZooAlert from './ZooAlert.svelte';

export type PriorityLevel = 'task' | 'update' | 'warning' | 'security' | 'critical';

export type Priority = {
  level: PriorityLevel;
  icon: Component<IconComponentProps>;
} | null;

export type AlertProgress = {
  value: number | null;
};

type DismissablePriorityState = {
  dismiss(): void;
};

// Banner modules export a function returning a priority provider, which decides when the banner renders and is passed back in its props.

export type PriorityProvider<S = DismissablePriorityState> = {
  get priority(): Priority;
  get progress(): AlertProgress | undefined;
} & S;

type BannerModule<S> = {
  default: Component<PriorityProvider<S>>;
  priorityProvider(): PriorityProvider<S>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALERT_MODULES: BannerModule<any>[] = [
  ZooAlert,
  UnverifiedDeviceAlert,
  RecoveryIncompleteAlert,
  WebUpdateAlert,
  DesktopUpdateAlert,
  SearchIndexTransferAlert,
];

export const [useAlertProviders, provideAlertProviders] =
  createContext<PriorityProvider<unknown>[]>();
