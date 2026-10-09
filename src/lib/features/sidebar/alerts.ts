import * as DesktopUpdateAlert from '#lib/ui/DesktopUpdateAlert.svelte';
import * as RecoveryIncompleteAlert from '#lib/ui/RecoveryIncompleteAlert.svelte';
import * as UnverifiedDeviceAlert from '#lib/ui/UnverifiedDeviceAlert.svelte';
import * as WebUpdateAlert from '#lib/ui/WebUpdateAlert.svelte';
import { createContext, type Component } from 'svelte';

export type Priority = null | 'update' | 'warning' | 'security';

// Banner modules must export a function that returns a priority provider,
// which will be used to determine when the banner component is rendered and how
// it contributes to the alert button's theme. The provider will be passed back to
// the banner component in its props to allow the banner's dismiss button to work.

export type PriorityProvider<S = object> = { get priority(): Priority; dismiss(): void } & S;

type BannerModule<S> = {
  default: Component<PriorityProvider<S>>;
  priorityProvider(): PriorityProvider<S>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALERT_MODULES: BannerModule<any>[] = [
  UnverifiedDeviceAlert,
  RecoveryIncompleteAlert,
  WebUpdateAlert,
  DesktopUpdateAlert,
];

export const [useAlertProviders, provideAlertProviders] =
  createContext<PriorityProvider<unknown>[]>();
