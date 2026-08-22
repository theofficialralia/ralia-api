export const STORAGE = Symbol('STORAGE');

export type StoredObject = {
  key: string;
  bucket: string;
  sizeBytes: number;
  checksumSha256: string;
  mimeType: string;
};

/**
 * Pluggable object storage — handoff §2. Local disk in dev, S3/R2 in prod, same
 * interface. Nothing above this knows which is bound.
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, mimeType: string): Promise<StoredObject>;
  /** A short-lived URL to read a private object (§7). Dev returns a local path URL. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Read an object's bytes — used by the dev file-serving route so uploads are browser-loadable. */
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
