export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface PickFilesRequest {
  filters: FileFilter[];
  multiple: boolean;
}

export interface SaveFileRequest {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  filters: FileFilter[];
  askLocation: boolean;
}

export interface ThemeFileSnapshot {
  path: string;
  modified: number;
  css: string;
}
