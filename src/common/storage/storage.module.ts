import { Global, Logger, Module } from '@nestjs/common';
import { CloudinaryStorageProvider } from './cloudinary.provider';
import { LocalStorageProvider } from './local-storage.provider';
import { STORAGE, StorageProvider } from './storage';

/**
 * Binds the STORAGE provider from config, same pattern as the mailer:
 *   - STORAGE_PROVIDER=cloudinary + CLOUDINARY_URL (or the discrete vars) → Cloudinary
 *   - otherwise → local disk (dev)
 *
 * Everything above STORAGE is provider-agnostic (put/signedUrl/read/delete), so a
 * Cloudflare R2 / S3 provider drops in here later with no change to callers.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      useFactory: (): StorageProvider => {
        const logger = new Logger('StorageModule');
        const choice = (process.env.STORAGE_PROVIDER ?? 'local').toLowerCase();
        // Per-environment folder every object is nested under: prod/staging/dev/local.
        const folder = (process.env.STORAGE_FOLDER ?? process.env.NODE_ENV ?? 'local')
          .toLowerCase()
          .replace(/[^a-z0-9/_-]/g, '')
          .replace(/^\/+|\/+$/g, '');
        if (choice === 'cloudinary') {
          const cloudinary = CloudinaryStorageProvider.fromEnv(folder);
          if (cloudinary) {
            logger.log(`Storage provider: cloudinary (folder: ${folder || 'none'})`);
            return cloudinary;
          }
          logger.warn('STORAGE_PROVIDER=cloudinary but no CLOUDINARY_URL / credentials found — falling back to local disk.');
        }
        logger.log(`Storage provider: local (dev disk, folder: ${folder || 'none'})`);
        return new LocalStorageProvider(folder);
      },
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
