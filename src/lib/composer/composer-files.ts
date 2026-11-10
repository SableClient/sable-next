import type { ImageMetadata } from '#lib/settings/definitions.js';

export interface StagedFile {
  id: number;
  file: File;
  spoiler: boolean;
  metadata: ImageMetadata;
}

export function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return withSourceName(transferFiles(transfer), transfer);
}

function transferFiles(transfer: DataTransfer): File[] {
  const files = Array.from(transfer.files).filter((file): file is File => file instanceof File);
  if (files.length > 0) return files;
  return Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function withSourceName(files: File[], transfer: DataTransfer): File[] {
  const [file] = files;
  if (files.length !== 1 || !file.type.startsWith('image/')) return files;
  const stem = sourceStem(transfer.getData('text/html'));
  if (!stem) return files;
  const extension = /\.[^.]+$/.exec(file.name)?.[0] ?? '';
  return [new File([file], stem + extension, { type: file.type, lastModified: file.lastModified })];
}

function sourceStem(html: string): string | null {
  if (!html) return null;
  const images = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('img');
  if (images.length !== 1) return null;
  try {
    const url = new URL(images[0].getAttribute('src') ?? '');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const name = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
    const stem = name.replace(/\.[^.]*$/, '').trim();
    return /^[^\\/:*?"<>|\p{Cc}]{1,100}$/u.test(stem) ? stem : null;
  } catch {
    return null;
  }
}

export function stageFiles(
  staged: readonly StagedFile[],
  files: readonly File[],
  nextId: () => number,
  metadata: ImageMetadata = 'location'
): StagedFile[] {
  return [...staged, ...files.map((file) => ({ id: nextId(), file, spoiler: false, metadata }))];
}

export function unstageFile(staged: readonly StagedFile[], id: number): StagedFile[] {
  return staged.filter((item) => item.id !== id);
}

export function toggleSpoiler(staged: readonly StagedFile[], id: number): StagedFile[] {
  return staged.map((item) => (item.id === id ? { ...item, spoiler: !item.spoiler } : item));
}

export function setMetadata(
  staged: readonly StagedFile[],
  id: number,
  metadata: ImageMetadata
): StagedFile[] {
  return staged.map((item) => (item.id === id ? { ...item, metadata } : item));
}

export type PreviewKind = 'image' | 'video';

export function previewKind(file: File): PreviewKind | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

export function objectSource(file: File, fragment = '') {
  return (node: HTMLImageElement | HTMLVideoElement) => {
    const url = URL.createObjectURL(file);
    node.src = url + fragment;
    return () => {
      URL.revokeObjectURL(url);
    };
  };
}

export function restoreFile(
  staged: readonly StagedFile[],
  item: StagedFile,
  index: number
): StagedFile[] {
  if (staged.some((entry) => entry.id === item.id)) return [...staged];
  return [...staged.slice(0, index), item, ...staged.slice(index)];
}
