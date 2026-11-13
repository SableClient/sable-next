export function embedServiceUrl(
  service: string,
  path: string,
  params: Record<string, string>
): string {
  const url = new URL(`${service}/_soliditas/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}
