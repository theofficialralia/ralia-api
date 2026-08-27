import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { ClientsService } from './clients.service';
import { ClientProfileDto, UpdateClientProfileDto } from './dto/client-profile.dto';

@ApiTags('client profile')
@ApiBearerAuth('access-token')
@Roles(Role.CLIENT)
@Controller('clients/me')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @ApiOperation({ summary: 'The current business profile' })
  @ApiOkResponse({ type: ClientProfileDto })
  me(@CurrentUser() user: AuthedUser): Promise<ClientProfileDto> {
    return this.clients.me(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Update business details', description: 'Partial — only the fields sent are changed.' })
  @ApiOkResponse({ type: ClientProfileDto })
  update(@CurrentUser() user: AuthedUser, @Body() dto: UpdateClientProfileDto): Promise<ClientProfileDto> {
    return this.clients.update(user.id, dto);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload the business logo', description: 'Image only (JPG/PNG/WebP/GIF), ≤2 MB. Replaces any existing logo.' })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiOkResponse({ type: ClientProfileDto })
  uploadLogo(@CurrentUser() user: AuthedUser, @UploadedFile() file?: Express.Multer.File): Promise<ClientProfileDto> {
    return this.clients.uploadLogo(user.id, file ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size } : undefined);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete (anonymise) the account',
    description:
      'Erasure per §7: the user is anonymised and signed out, ledger postings are preserved. Blocked while campaigns are still active with money in flight.',
  })
  deleteAccount(@CurrentUser() user: AuthedUser): Promise<void> {
    return this.clients.deleteAccount(user.id);
  }
}
