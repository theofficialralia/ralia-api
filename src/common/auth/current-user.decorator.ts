import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthedUser } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthedUser => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.user) {
      // Reaching here means a handler used @CurrentUser() but was marked
      // @Public() or missed the guard — a wiring bug, not a client error.
      throw new Error('@CurrentUser() used on a route without JwtAuthGuard');
    }
    return request.user;
  },
);
