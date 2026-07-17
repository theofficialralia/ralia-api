import { Global, Module } from '@nestjs/common';
import { LocalStorageProvider } from './local-storage.provider';
import { STORAGE } from './storage';

/**
 * Binds the local provider in dev. An S3/R2 provider slots in behind STORAGE by
 * config (harden slice) with no change above this line.
 */
@Global()
@Module({
  providers: [{ provide: STORAGE, useClass: LocalStorageProvider }],
  exports: [STORAGE],
})
export class StorageModule {}
