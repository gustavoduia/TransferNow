export interface FileMeta {
  id: number;
  name: string;
  size: number;
  type: string;
}

/** Mensagens de controle no DataChannel. Os pedaços do arquivo vão como binário puro. */
export type PortalMessage =
  | { t: "manifest"; files: FileMeta[]; totalBytes: number }
  | { t: "accept" }
  | { t: "reject"; reason: "declined" | "too_large" }
  | { t: "file-start"; id: number }
  | { t: "file-end"; id: number; sha256: string }
  | { t: "verified"; id: number; ok: boolean }
  | { t: "cancel" };

export const CHUNK_SIZE = 64 * 1024;
export const BUFFER_HIGH = 8 * 1024 * 1024;
export const BUFFER_LOW = 1024 * 1024;

export interface Progress {
  bytesDone: number;
  totalBytes: number;
  fileIndex: number;
  fileCount: number;
  fileName: string;
}

export function encode(msg: PortalMessage): string {
  return JSON.stringify(msg);
}

export function decode(raw: string): PortalMessage | null {
  try {
    return JSON.parse(raw) as PortalMessage;
  } catch {
    return null;
  }
}
