import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
