import { Controller, Get, Inject, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STORAGE, StorageProvider } from '../../common/storage/storage';

/**
 * Serves an uploaded object's bytes by File id so the browser can load posters
 * and proof screenshots (the local dev provider stores files on disk and its
 * signedUrl is a bare file:// path a browser can't open).
 *
 * Public and keyed by an unguessable UUID — acceptable for the dev/local
 * provider. In production this belongs behind S3/R2 signed URLs, not here.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Fetch an uploaded file (dev)', description: 'Streams the object bytes for a File id. Dev/local-storage convenience.' })
  async get(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const file = await this.prisma.file.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!file) throw new NotFoundException('No such file.');

    // Provider-agnostic: a remote provider (Cloudinary/R2) yields an http(s) URL we
    // just redirect to (browser loads the CDN directly); the local dev provider
    // yields a file:// path, so we stream the bytes ourselves. Callers never care.
    const url = await this.storage.signedUrl(file.storageKey);
    if (/^https?:\/\//i.test(url)) {
      res.redirect(302, url);
      return;
    }
    const bytes = await this.storage.read(file.storageKey);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(bytes);
  }
}
