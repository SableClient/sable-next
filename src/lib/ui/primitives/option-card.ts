import type { Component } from 'svelte';

export type OptionCard<Value extends string> = {
  value: Value;
  label: string;
  hint?: string;
  icon?: Component;
  disabled?: boolean;
};
