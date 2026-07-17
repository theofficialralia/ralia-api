import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminCapability, Role } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export const ROLES_KEY = 'required_roles';
export const CAPABILITIES_KEY = 'required_capabilities';

export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Admin capabilities are checked separately from the ADMIN role so that
 * reviewing evidence and recording money stay separable — handoff §7. One person
 * may hold both today; the check must not assume it.
 */
export const RequiresCapability = (...caps: AdminCapability[]): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITIES_KEY, caps);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const caps = this.reflector.getAllAndOverride<AdminCapability[]>(CAPABILITIES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length && !caps?.length) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    if (roles?.length && !roles.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException('You do not have access to this resource.');
    }

    if (caps?.length) {
      const adminRole = await this.prisma.userRole.findUnique({
        where: { userId_role: { userId: user.id, role: Role.ADMIN } },
      });
      const held = adminRole?.capabilities ?? [];
      if (!caps.every((c) => held.includes(c))) {
        throw new ForbiddenException('You do not have the capability for this action.');
      }
    }

    return true;
  }
}
