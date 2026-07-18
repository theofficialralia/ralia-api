import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { CreateSubmissionDto, SubmissionDto } from './dto/evidence.dto';
import { EvidenceService } from './evidence.service';

@ApiTags('evidence')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller('assignments/:id')
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  @Post('submission')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  // Uploads are expensive; rate-limit them per §7.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Submit proof for an assignment',
    description:
      'A screenshot is required; public_url is optional because a WhatsApp status has none. The screenshot is perceptually hashed and compared with existing proof; a match sets auto_flag for the admin. Nothing auto-approves — every submission lands PENDING in the review queue.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        public_url: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: SubmissionDto })
  submit(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSubmissionDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<SubmissionDto> {
    return this.evidence.submit(
      id,
      user.id,
      file ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size } : undefined,
      dto,
    );
  }

  @Get('submissions')
  @ApiOperation({ summary: 'My submissions for this assignment' })
  @ApiOkResponse({ type: [SubmissionDto] })
  list(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<SubmissionDto[]> {
    return this.evidence.listForAssignment(id, user.id);
  }
}
