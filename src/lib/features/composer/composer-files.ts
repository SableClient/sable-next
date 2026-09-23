export interface StagedFile {
  id: number;
  file: File;
  spoiler: boolean;
}

export function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files).filter((file): file is File => file instanceof File);
  if (files.length > 0) return files;
  return Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function stageFiles(
  staged: readonly StagedFile[],
  files: readonly File[],
  nextId: () => number
): StagedFile[] {
  return [...staged, ...files.map((file) => ({ id: nextId(), file, spoiler: false }))];
}

export function unstageFile(staged: readonly StagedFile[], id: number): StagedFile[] {
  return staged.filter((item) => item.id !== id);
}

export function toggleSpoiler(staged: readonly StagedFile[], id: number): StagedFile[] {
  return staged.map((item) => (item.id === id ? { ...item, spoiler: !item.spoiler } : item));
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
