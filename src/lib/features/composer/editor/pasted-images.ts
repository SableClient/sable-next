import type { Slice } from 'prosemirror-model';

const FETCHABLE = /^(?:blob|data):/;

export function pastedImageSources(slice: Slice): string[] {
  if (slice.content.textBetween(0, slice.content.size).trim() !== '') return [];

  const sources: string[] = [];
  slice.content.descendants((node) => {
    if (node.type.name !== 'image') return true;
    const src = node.attrs.src as string;
    if (FETCHABLE.test(src)) sources.push(src);
    return false;
  });
  return sources;
}

export async function filesFromSources(sources: readonly string[]): Promise<File[]> {
  const files = await Promise.all(sources.map((source, index) => fileFromSource(source, index)));
  return files.filter((file): file is File => file !== null);
}

async function fileFromSource(source: string, index: number): Promise<File | null> {
  try {
    const blob = await (await fetch(source)).blob();
    if (!blob.type.startsWith('image/')) return null;
    const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type.slice('image/'.length);
    const suffix = index === 0 ? '' : `-${index + 1}`;
    return new File([blob], `pasted-image${suffix}.${extension}`, { type: blob.type });
  } catch (error) {
    console.debug('[sable composer] pasted image unavailable', error);
    return null;
  }
}
