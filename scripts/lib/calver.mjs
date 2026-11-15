const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextCalver(current, date = new Date()) {
  const match = STABLE_VERSION.exec(current ?? '');
  if (!match) throw new Error(`Expected a stable version (got: ${current})`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Version components must be safe integers (got: ${current})`);
  }

  const year = date.getUTCFullYear() - 2000;
  const month = date.getUTCMonth() + 1;
  if (!Number.isInteger(year) || year < 0 || year > 99) {
    throw new Error('Short-year CalVer requires a date between 2000 and 2099');
  }

  const next =
    major > year || (major === year && minor >= month)
      ? [major, minor, patch + 1]
      : [year, month, 0];
  if (next[0] > 99 || next[1] < 1 || next[1] > 12 || next[2] > 999) {
    throw new Error(`Cannot represent the next CalVer release after ${current}`);
  }
  return next.join('.');
}
