export function hasAndroidCompositionQuirk(): boolean {
  return typeof navigator !== 'undefined' && /Android \d/.test(navigator.userAgent);
}

export function hasIosKeyboardContextQuirk(): boolean {
  if (typeof navigator === 'undefined') return false;
  const agent = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
  );
}
