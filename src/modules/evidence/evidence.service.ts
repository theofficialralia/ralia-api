import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, DeliverySlotStatus, Submission, Verdict } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { computeAssignmentRollup } from '../../common/delivery/delivery';
import { DEFAULT_HAMMING_THRESHOLD, hammingDistance, perceptualHash } from '../../common/phash/phash';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STORAGE, StorageProvider } from '../../common/storage/storage';
import { CreateSubmissionDto, SubmissionDto } from './dto/evidence.dto';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
};

/** Delivery-slot states from which a promoter may (re)submit proof for that post. */
const SUBMITTABLE_SLOT: DeliverySlotStatus[] = [DeliverySlotStatus.PENDING, DeliverySlotStatus.REJECTED];

@Injectable()
export class EvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /**
   * Submit proof for an assignment.
   *
   * A screenshot is required; the public URL is optional because a WhatsApp
   * status has none (§5.5). On receipt the screenshot is perceptually hashed and
   * compared against every existing artifact; a match sets auto_flag and links
   * reuse_of_id.
   *
   * Nothing here approves anything. Every submission lands PENDING in the admin
   * queue — the flag surfaces risk for a human to judge, per §5.5.
   */
  async submit(
    assignmentId: string,
    promoterId: string,
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    dto: CreateSubmissionDto,
  ): Promise<SubmissionDto> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { deliverySlots: true },
    });
    // 404 rather than 403 for someone else's assignment — a 403 confirms the id.
    if (!assignment || assignment.promoterId !== promoterId) {
      throw new NotFoundException('No such assignment.');
    }
    if (assignment.status === AssignmentStatus.CANCELLED) {
      throw new BadRequestException('This assignment is closed and is not awaiting proof.');
    }

    // §multi-day: proof answers a specific scheduled post. Use the one named by the
    // promoter, or default to the earliest post still awaiting proof.
    const slots = assignment.deliverySlots;
    const target = dto.delivery_slot_id
      ? slots.find((s) => s.id === dto.delivery_slot_id)
      : [...slots].filter((s) => SUBMITTABLE_SLOT.includes(s.status)).sort((a, b) => a.index - b.index)[0];
    if (!target) {
      throw new BadRequestException(
        dto.delivery_slot_id ? 'No such post on this assignment.' : 'No post is awaiting proof right now.',
      );
    }
    if (!SUBMITTABLE_SLOT.includes(target.status)) {
      throw new BadRequestException(`Day ${target.index} is ${target.status.toLowerCase()} and is not awaiting proof.`);
    }

    if (!file) throw new BadRequestException('A screenshot is required.');
    if (file.size > MAX_BYTES) throw new BadRequestException('Screenshot exceeds the 10 MB limit.');
    if (!ALLOWED_MIME[file.mimetype]) {
      throw new BadRequestException(`Unsupported image type ${file.mimetype}.`);
    }

    // Hash before storing: a screenshot we cannot decode is not proof, and
    // failing here avoids an orphaned object in storage.
    let phash: string;
    try {
      phash = await perceptualHash(file.buffer);
    } catch {
      throw new BadRequestException('That file could not be read as an image.');
    }

    const reuseOfId = await this.findReuse(phash);

    const key = `submissions/${assignmentId}/${randomUUID()}`;
    const stored = await this.storage.put(key, file.buffer, file.mimetype);

    const submission = await this.prisma.$transaction(async (tx) => {
      const fileRow = await tx.file.create({
        data: {
          storageKey: stored.key,
          bucket: stored.bucket,
          mimeType: stored.mimeType,
          sizeBytes: stored.sizeBytes,
          checksumSha256: stored.checksumSha256,
          uploadedBy: promoterId,
        },
      });

      const created = await tx.submission.create({
        data: {
          assignmentId,
          deliverySlotId: target.id,
          publicUrl: dto.public_url ?? null,
          note: dto.note ?? null,
          claimedViews: dto.claimed_views ?? null,
          autoFlag: reuseOfId !== null,
          verdict: Verdict.PENDING,
        },
      });

      await tx.proofArtifact.create({
        data: { submissionId: created.id, fileId: fileRow.id, phash, reuseOfId },
      });

      // This post is now awaiting review; the assignment's status is the roll-up
      // of all its posts.
      await tx.deliverySlot.update({ where: { id: target.id }, data: { status: DeliverySlotStatus.SUBMITTED } });
      const nextStatuses = slots.map((s) => (s.id === target.id ? { index: s.index, status: DeliverySlotStatus.SUBMITTED } : { index: s.index, status: s.status }));
      const rollup = computeAssignmentRollup(nextStatuses);
      await tx.assignment.update({ where: { id: assignmentId }, data: { status: rollup.status } });

      return created;
    });

    return toDto(submission);
  }

  /**
   * The existing artifact this screenshot perceptually duplicates, if any.
   *
   * Compares against every stored artifact. That is a full scan, which is
   * correct and fast enough at MVP volume — Hamming distance cannot be expressed
   * as a SQL index lookup without a BK-tree or similar, and building one before
   * there is any data would be premature.
   */
  private async findReuse(phash: string): Promise<string | null> {
    const artifacts = await this.prisma.proofArtifact.findMany({
      select: { id: true, phash: true },
      orderBy: { createdAt: 'asc' },
    });

    let best: { id: string; distance: number } | null = null;
    for (const artifact of artifacts) {
      if (artifact.phash.length !== phash.length) continue;
      const distance = hammingDistance(phash, artifact.phash);
      if (distance <= DEFAULT_HAMMING_THRESHOLD && (best === null || distance < best.distance)) {
        best = { id: artifact.id, distance };
      }
    }

    // Point at the earliest match, so a chain of reuses all reference the
    // original rather than each other.
    return best?.id ?? null;
  }

  async listForAssignment(assignmentId: string, promoterId: string): Promise<SubmissionDto[]> {
    const assignment = await this.prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!assignment || assignment.promoterId !== promoterId) {
      throw new NotFoundException('No such assignment.');
    }
    const submissions = await this.prisma.submission.findMany({
      where: { assignmentId },
      orderBy: { submittedAt: 'desc' },
    });
    return submissions.map(toDto);
  }
}

function toDto(s: Submission): SubmissionDto {
  return {
    id: s.id,
    assignment_id: s.assignmentId,
    delivery_slot_id: s.deliverySlotId,
    verdict: s.verdict,
    auto_flag: s.autoFlag,
    public_url: s.publicUrl,
    note: s.note,
    claimed_views: s.claimedViews,
    verified_reach: s.verifiedReach,
    submitted_at: s.submittedAt.toISOString(),
  };
}
