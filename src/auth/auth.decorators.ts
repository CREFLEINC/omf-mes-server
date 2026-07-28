import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

import { AuthPrincipal } from './auth.service';

export const PUBLIC_KEY = 'auth:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 여러 개를 넘기면 **전부** 있어야 통과한다. */
export const PERMISSIONS_KEY = 'auth:permissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    return ctx.switchToHttp().getRequest<{ user: AuthPrincipal }>().user;
  },
);

export const ActorId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): bigint | undefined => {
    return ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user?.appUserId;
  },
);
