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
        if (choice === 'cloudinary') {
          const cloudinary = CloudinaryStorageProvider.fromEnv();
          if (cloudinary) {
            logger.log('Storage provider: cloudinary');
            return cloudinary;
          }
          logger.warn('STORAGE_PROVIDER=cloudinary but no CLOUDINARY_URL / credentials found — falling back to local disk.');
        }
        logger.log('Storage provider: local (dev disk)');
        return new LocalStorageProvider();
      },
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
