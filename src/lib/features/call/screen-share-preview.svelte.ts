export type PreviewCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const previewCorner = $state<{ value: PreviewCorner }>({ value: 'bottom-right' });

export const dismissedPreview = $state<{ key: string | null }>({ key: null });
