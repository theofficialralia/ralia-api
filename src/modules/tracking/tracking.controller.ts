import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { TrackingService } from './tracking.service';

/**
 * The public tracking redirect. Standalone (§5.5): no auth, no /v1 prefix (see
 * main.ts), and it must keep serving even while the main API is under load.
 */
@ApiExcludeController()
@Controller('r')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Public()
  @SkipThrottle()
  @Get(':token')
  async redirect(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const resolution = await this.tracking.resolveAndRecord(token, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? '',
      referrer: typeof req.headers['referer'] === 'string' ? req.headers['referer'] : undefined,
    });

    if (!resolution) {
      // An unknown or malformed token is not a place to leak detail — a plain 404.
      res.status(404).send('Not found');
      return;
    }

    // 302: the destination is the campaign's, and may change; never cache the hop.
    res.redirect(302, resolution.destinationUrl);
  }
}

/**
 * The client IP. Behind a proxy this is the left-most X-Forwarded-For entry; the
 * raw value is only ever hashed, never stored.
 */
function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
