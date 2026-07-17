import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AssetKind, CampaignStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { STORAGE, StorageProvider } from '../../common/storage/storage';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CampaignsService } from './campaigns.service';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/gif': true,
  'video/mp4': true,
  'application/pdf': true,
};

export type AssetView = {
  id: string;
  kind: AssetKind;
  caption_text: string | null;
  order_index: number;
  file: { id: string; mime_type: string; size_bytes: number; url: string } | null;
};

/**
 * Campaign assets. Thin slice: one file per call, size- and type-checked. Multi
 * upload and image compression are the harden slice.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async list(userId: string, campaignId: string): Promise<AssetView[]> {
    await this.campaigns.get(userId, campaignId); // ownership check
    const assets = await this.prisma.campaignAsset.findMany({
      where: { campaignId },
      include: { file: true },
      orderBy: { orderIndex: 'asc' },
    });

    return Promise.all(
      assets.map(async (a) => ({
        id: a.id,
        kind: a.kind,
        caption_text: a.captionText,
        order_index: a.orderIndex,
        file: a.file
          ? {
              id: a.file.id,
              mime_type: a.file.mimeType,
              size_bytes: a.file.sizeBytes,
              url: await this.storage.signedUrl(a.file.storageKey),
            }
          : null,
      })),
    );
  }

  async upload(
    userId: string,
    campaignId: string,
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    meta: { kind: AssetKind; caption_text?: string; order_index?: number },
  ): Promise<AssetView> {
    const campaign = await this.campaigns.get(userId, campaignId);
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.QUOTED) {
      throw new BadRequestException('Assets can only be added while the campaign is a draft.');
    }

    // A CAPTION asset is text-only; everything else needs a file.
    if (meta.kind === AssetKind.CAPTION) {
      if (!meta.caption_text?.trim()) {
        throw new BadRequestException('A caption asset needs caption_text.');
      }
      const asset = await this.prisma.campaignAsset.create({
        data: {
          campaignId,
          kind: meta.kind,
          captionText: meta.caption_text.trim(),
          orderIndex: meta.order_index ?? 0,
        },
        include: { file: true },
      });
      return { id: asset.id, kind: asset.kind, caption_text: asset.captionText, order_index: asset.orderIndex, file: null };
    }

    if (!file) throw new BadRequestException('A file is required for this asset kind.');
    if (file.size > MAX_BYTES) throw new BadRequestException('File exceeds the 10 MB limit.');
    if (!ALLOWED_MIME[file.mimetype]) {
      throw new BadRequestException(`Unsupported file type ${file.mimetype}.`);
    }

    const key = `campaigns/${campaignId}/assets/${randomUUID()}`;
    const stored = await this.storage.put(key, file.buffer, file.mimetype);

    const asset = await this.prisma.$transaction(async (tx) => {
      const fileRow = await tx.file.create({
        data: {
          storageKey: stored.key,
          bucket: stored.bucket,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          checksumSha256: stored.checksumSha256,
          uploadedBy: userId,
        },
      });
      return tx.campaignAsset.create({
        data: {
          campaignId,
          kind: meta.kind,
          fileId: fileRow.id,
          captionText: meta.caption_text?.trim() ?? null,
          orderIndex: meta.order_index ?? 0,
        },
        include: { file: true },
      });
    });

    return {
      id: asset.id,
      kind: asset.kind,
      caption_text: asset.captionText,
      order_index: asset.orderIndex,
      file: asset.file
        ? {
            id: asset.file.id,
            mime_type: asset.file.mimeType,
            size_bytes: asset.file.sizeBytes,
            url: await this.storage.signedUrl(asset.file.storageKey),
          }
        : null,
    };
  }
}
