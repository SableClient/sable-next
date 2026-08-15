export interface StagedFile {
  id: number;
  file: File;
}

export function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return Array.from(transfer.files).filter((file): file is File => file instanceof File);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function stageFiles(
  staged: readonly StagedFile[],
  files: readonly File[],
  nextId: () => number
): StagedFile[] {
  return [...staged, ...files.map((file) => ({ id: nextId(), file }))];
}

export function unstageFile(staged: readonly StagedFile[], id: number): StagedFile[] {
  return staged.filter((item) => item.id !== id);
}
