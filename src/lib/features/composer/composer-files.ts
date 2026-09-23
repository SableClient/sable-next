export interface StagedFile {
  id: number;
  file: File;
  spoiler: boolean;
}

export function canSpoiler(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
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
