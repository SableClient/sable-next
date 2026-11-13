let current = $state('');
let direction = $state<'ltr' | 'rtl'>('ltr');
let revision = $state(0);

export function currentLanguage(): string {
  return current;
}

export function currentDirection(): 'ltr' | 'rtl' {
  return direction;
}

export function inlineSide<Side extends string>(side: Side): Side {
  if (direction === 'ltr') return side;
  if (side === 'left') return 'right' as Side;
  if (side === 'right') return 'left' as Side;
  return side;
}

export function inlineKey(key: string): string {
  if (direction === 'ltr') return key;
  if (key === 'ArrowLeft') return 'ArrowRight';
  if (key === 'ArrowRight') return 'ArrowLeft';
  return key;
}

export function setCurrentLanguage(code: string, dir: 'ltr' | 'rtl'): void {
  current = code;
  direction = dir;
}

export function trackTranslations(): void {
  void revision;
}

export function translationsChanged(): void {
  revision += 1;
}
