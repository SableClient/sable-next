export type GalleryLayout = 'one' | 'two' | 'three' | 'featured';

export interface GalleryEntry<T> {
  item: T;
  /** Position in the event, which the viewer and spoiler keys use. */
  index: number;
}

export interface GalleryGroup<T> {
  layout: GalleryLayout;
  entries: GalleryEntry<T>[];
}

export interface GalleryPartition<T> {
  groups: GalleryGroup<T>[];
  attachments: GalleryEntry<T>[];
}

function lastGroup(count: number): [size: number, layout: GalleryLayout] {
  if (count >= 9) return [9, 'three'];
  if (count >= 6) return [6, 'three'];
  if (count >= 4) return [4, 'two'];
  if (count === 3) return [3, 'featured'];
  if (count === 2) return [2, 'two'];
  return [1, 'one'];
}

/** Grids are taken from the end, so a leftover image leads the gallery. */
export function partitionGallery<T extends { kind: string }>(
  items: readonly T[]
): GalleryPartition<T> {
  const media: GalleryEntry<T>[] = [];
  const attachments: GalleryEntry<T>[] = [];
  for (const [index, item] of items.entries()) {
    (item.kind === 'image' || item.kind === 'video' ? media : attachments).push({ item, index });
  }

  const groups: GalleryGroup<T>[] = [];
  let remaining = media.length;
  while (remaining > 0) {
    const [size, layout] = lastGroup(remaining);
    groups.unshift({ layout, entries: media.slice(remaining - size, remaining) });
    remaining -= size;
  }
  return { groups, attachments };
}
