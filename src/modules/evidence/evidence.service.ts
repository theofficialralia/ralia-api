import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, Submission, Verdict } from '@prisma/client';
import { randomUUID } from 'node:crypto';
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

/** Assignment states from which a promoter may submit proof. */
const SUBMITTABLE: AssignmentStatus[] = [AssignmentStatus.IN_PROGRESS, AssignmentStatus.REJECTED];

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
    const assignment = await this.prisma.assignment.findUnique({ where: { id: assignmentId } });
    // 404 rather than 403 for someone else's assignment — a 403 confirms the id.
    if (!assignment || assignment.promoterId !== promoterId) {
      throw new NotFoundException('No such assignment.');
    }
    if (!SUBMITTABLE.includes(assignment.status)) {
      throw new BadRequestException(
        `This assignment is ${assignment.status.toLowerCase()} and is not awaiting proof.`,
      );
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
          publicUrl: dto.public_url ?? null,
          note: dto.note ?? null,
          autoFlag: reuseOfId !== null,
          verdict: Verdict.PENDING,
        },
      });

      await tx.proofArtifact.create({
        data: { submissionId: created.id, fileId: fileRow.id, phash, reuseOfId },
      });

      await tx.assignment.update({
        where: { id: assignmentId },
        data: { status: AssignmentStatus.SUBMITTED },
      });

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
    verdict: s.verdict,
    auto_flag: s.autoFlag,
    public_url: s.publicUrl,
    note: s.note,
    submitted_at: s.submittedAt.toISOString(),
  };
}
