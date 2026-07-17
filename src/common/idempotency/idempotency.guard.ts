import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

export const IDEMPOTENT_KEY = 'requires_idempotency_key';

/**
 * Mark a money-mutating handler. Without an `Idempotency-Key` header the request
 * is rejected before it reaches business logic — handoff §2.
 */
export const RequiresIdempotencyKey = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IDEMPOTENT_KEY, true);

const UUID_V4ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;

    if (!key || key.trim().length === 0) {
      throw new BadRequestException(
        'This endpoint moves money and requires an Idempotency-Key header.',
      );
    }
    if (!UUID_V4ISH.test(key)) {
      // A key the client didn't generate per-intent (a constant, a timestamp)
      // silently defeats the whole mechanism. Require a UUID shape.
      throw new BadRequestException('Idempotency-Key must be a UUID.');
    }

    return true;
  }
}
