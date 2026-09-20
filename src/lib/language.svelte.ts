let current = $state('');

export function currentLanguage(): string {
  return current;
}

export function setCurrentLanguage(code: string): void {
  current = code;
}
