export function callServiceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      /[?#]/.test(url.href)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}
