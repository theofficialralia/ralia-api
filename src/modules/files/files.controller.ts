import { Controller, Get, Inject, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STORAGE, StorageProvider } from '../../common/storage/storage';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf', 'video/mp4': 'mp4',
};

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
  @ApiOperation({ summary: 'Fetch an uploaded file', description: 'Streams the object bytes for a File id. Pass ?download=1 to force a download (attachment) instead of inline view.' })
  async get(@Param('id') id: string, @Query('download') download: string | undefined, @Res() res: Response): Promise<void> {
    const file = await this.prisma.file.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!file) throw new NotFoundException('No such file.');

    const wantDownload = download === '1' || download === 'true';
    const filename = `ralia-poster.${EXT_BY_MIME[file.mimeType] ?? 'bin'}`;

    // Provider-agnostic: a remote provider (Cloudinary/R2) yields an http(s) URL we
    // just redirect to (browser loads the CDN directly); the local dev provider
    // yields a file:// path, so we stream the bytes ourselves. Callers never care.
    const url = await this.storage.signedUrl(file.storageKey);
    if (/^https?:\/\//i.test(url)) {
      // Cloudinary forces a download via the fl_attachment delivery flag; other
      // hosts fall back to a plain redirect (can't force cross-origin).
      const finalUrl = wantDownload && url.includes('/upload/') ? url.replace('/upload/', `/upload/fl_attachment:${filename}/`) : url;
      res.redirect(302, finalUrl);
      return;
    }
    const bytes = await this.storage.read(file.storageKey);
    res.setHeader('Content-Type', file.mimeType);
    if (wantDownload) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(bytes);
  }
}
