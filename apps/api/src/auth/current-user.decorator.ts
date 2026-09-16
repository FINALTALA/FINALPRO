import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from './session-auth.guard';

/**
 * Only valid on a route behind `@UseGuards(SessionAuthGuard)`, which is
 * what actually populates `req.user`. Throws rather than returning
 * `undefined` if used without the guard, so a missing `@UseGuards`
 * fails loudly in development instead of silently exposing a route.
 */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.user) {
      throw new InternalServerErrorException(
        '@CurrentUser() used on a route with no SessionAuthGuard',
      );
    }
    return request.user;
  },
);
