import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StorageProvider, StoredObject } from './storage';

/**
 * Dev storage: writes under ./uploads (gitignored). Not for production — there is
 * no access control on a local path beyond the process user, and signedUrl here
 * is a bare file URL, not a time-limited grant.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root = join(process.cwd(), 'uploads');
  private readonly bucket = process.env.S3_BUCKET ?? 'ralia-dev';

  async put(key: string, body: Buffer, mimeType: string): Promise<StoredObject> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);

    return {
      key,
      bucket: this.bucket,
      sizeBytes: body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
      mimeType,
    };
  }

  async read(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }

  async signedUrl(key: string): Promise<string> {
    // Dev only. A real provider returns a time-limited signed URL.
    return `file://${join(this.root, key)}`;
  }

  async delete(key: string): Promise<void> {
    await rm(join(this.root, key), { force: true });
  }
}
