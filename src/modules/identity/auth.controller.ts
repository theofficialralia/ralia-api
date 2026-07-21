import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser, Public } from '../../common/auth/jwt-auth.guard';
import { AuthService } from './auth.service';
import {
  AcceptedDto,
  ChangePasswordDto,
  LoginDto,
  MeDto,
  OtpRequestDto,
  OtpVerifyDto,
  RefreshDto,
  RegisterDto,
  RegisterResponseDto,
  TokenPairDto,
} from './dto/auth.dto';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** Create a client or promoter account. Sends a phone-verification code. */
  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a client or promoter' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiConflictResponse({ description: 'Email or phone already registered.' })
  register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.auth.register(dto);
  }

  /** Send a phone-verification code. Always reports success. */
  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a verification code',
    description:
      'Always returns 202, whether or not the number is registered — an unauthenticated caller does not get to enumerate accounts.',
  })
  @ApiOkResponse({ type: AcceptedDto })
  async requestOtp(@Body() dto: OtpRequestDto): Promise<AcceptedDto> {
    await this.auth.requestOtp(dto.phone_e164);
    return { accepted: true, message: 'If that number is registered, a code has been sent.' };
  }

  /** Verify the code. On success the account becomes ACTIVE and a session is issued. */
  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a phone code and receive tokens' })
  @ApiOkResponse({ type: TokenPairDto })
  verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.auth.verifyOtp(dto.phone_e164, dto.code, req.headers['user-agent']);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse({ description: 'Email or password is incorrect.' })
  @ApiForbiddenResponse({ description: 'Account suspended, or phone not yet verified (code PHONE_NOT_VERIFIED).' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.auth.login(dto, req.headers['user-agent']);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Rotates: the presented token is revoked. Replaying an already-revoked token revokes every session for that user.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.sessions.rotate(dto.refresh_token, req.headers['user-agent']);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.sessions.revoke(dto.refresh_token);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The current user' })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUser() user: AuthedUser): Promise<MeDto> {
    return this.auth.me(user.id) as Promise<MeDto>;
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Change password',
    description: 'Requires the current password. Revokes all other sessions on success.',
  })
  async changePassword(@CurrentUser() user: AuthedUser, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(user.id, dto.current_password, dto.new_password);
  }
}
