import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StorageProvider, StoredObject } from './storage';

type CloudinaryConfig = { cloudName: string; apiKey: string; apiSecret: string };

/** image/* → image, video/* → video, everything else → raw (PDFs, etc.). */
function resourceType(mime: string): 'image' | 'video' | 'raw' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'raw';
}

/**
 * Cloudinary object storage behind the same {@link StorageProvider} seam as the
 * local dev provider — chosen by env in storage.module. Uses the REST upload API
 * directly via global fetch (no SDK dependency), mirroring the Resend mailer.
 *
 * `put` returns the delivery URL as the object key, so `signedUrl`/`read` and the
 * file-serving route treat any http(s) key as a ready-to-use URL. A future
 * Cloudflare R2 / S3 provider implements the same three methods and drops in with
 * no change above this line.
 */
export class CloudinaryStorageProvider implements StorageProvider {
  readonly name = 'cloudinary';
  private readonly logger = new Logger(CloudinaryStorageProvider.name);

  constructor(private readonly cfg: CloudinaryConfig) {}

  /** Build from CLOUDINARY_URL (cloudinary://key:secret@cloud) or the discrete vars. Null if unset. */
  static fromEnv(): CloudinaryStorageProvider | null {
    const url = process.env.CLOUDINARY_URL;
    if (url) {
      const m = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim());
      if (m) return new CloudinaryStorageProvider({ apiKey: m[1]!, apiSecret: m[2]!, cloudName: m[3]! });
    }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (cloudName && apiKey && apiSecret) return new CloudinaryStorageProvider({ cloudName, apiKey, apiSecret });
    return null;
  }

  private sign(params: Record<string, string>): string {
    // Cloudinary: sha1 of the alphabetically-sorted params (excluding file/api_key/
    // resource_type) joined k=v with &, then the api_secret appended.
    const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    return createHash('sha1').update(toSign + this.cfg.apiSecret).digest('hex');
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<StoredObject> {
    const publicId = key.replace(/^\/+/, '');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = this.sign({ public_id: publicId, timestamp });
    const type = resourceType(mimeType);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: mimeType }), publicId);
    form.append('public_id', publicId);
    form.append('timestamp', timestamp);
    form.append('api_key', this.cfg.apiKey);
    form.append('signature', signature);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/${type}/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloudinary upload failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { secure_url: string; bytes?: number };
    return {
      key: json.secure_url, // the delivery URL doubles as the object key
      bucket: this.cfg.cloudName,
      sizeBytes: json.bytes ?? body.byteLength,
      checksumSha256: createHash('sha256').update(body).digest('hex'),
      mimeType,
    };
  }

  async signedUrl(key: string): Promise<string> {
    // Delivered assets are public https URLs; the stored key already is one.
    return key;
  }

  async read(key: string): Promise<Buffer> {
    const res = await fetch(key);
    if (!res.ok) throw new Error(`Cloudinary read failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    // key is a delivery URL: .../<resource_type>/upload/v<version>/<public_id>.<ext>
    const m = /\/(image|video|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/.exec(key);
    if (!m) { this.logger.warn(`Cannot parse Cloudinary public_id from key; skipping delete: ${key}`); return; }
    const type = m[1]!;
    const publicId = m[2]!;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = this.sign({ public_id: publicId, timestamp });
    const form = new FormData();
    form.append('public_id', publicId);
    form.append('timestamp', timestamp);
    form.append('api_key', this.cfg.apiKey);
    form.append('signature', signature);
    const res = await fetch(`https://api.cloudinary.com/v1_1/${this.cfg.cloudName}/${type}/destroy`, { method: 'POST', body: form });
    if (!res.ok) this.logger.warn(`Cloudinary delete failed (${res.status}) for ${publicId}`);
  }
}
