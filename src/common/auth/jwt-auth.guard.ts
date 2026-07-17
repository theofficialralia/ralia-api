import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const IS_PUBLIC = 'is_public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export type AuthedUser = {
  id: string;
  roles: Role[];
  status: UserStatus;
};

declare module 'express' {
  interface Request {
    user?: AuthedUser;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length);
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // The token's roles claim is a snapshot from issue time. Read the user so a
    // suspension or a role change takes effect now, not in fifteen minutes when
    // the access token happens to expire.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { roles: true },
    });
    if (!user || user.deletedAt) throw new UnauthorizedException('Invalid token');
    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.BANNED) {
      throw new ForbiddenException('This account has been suspended.');
    }

    request.user = {
      id: user.id,
      roles: user.roles.map((r) => r.role),
      status: user.status,
    };
    return true;
  }
}
