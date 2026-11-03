export function isNightlyBuild(): boolean {
  return import.meta.env.VITE_APP_VERSION?.includes('-nightly.') ?? false;
}
