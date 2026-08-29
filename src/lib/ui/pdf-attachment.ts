export function isPdfAttachment(mime: string | null, body: string): boolean {
  if (mime === 'application/pdf') return true;
  if (mime !== null && mime !== 'application/octet-stream') return false;
  return body.toLowerCase().endsWith('.pdf');
}
