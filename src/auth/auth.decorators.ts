import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

import { AuthPrincipal } from './auth.service';

/** 인증 없이 접근할 수 있는 엔드포인트에 붙인다(로그인·헬스체크 등). */
export const PUBLIC_KEY = 'auth:public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 이 엔드포인트가 요구하는 기능권한. 여러 개면 **전부** 있어야 한다. */
export const PERMISSIONS_KEY = 'auth:permissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** 인증된 주체를 핸들러 인자로 받는다. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    return ctx.switchToHttp().getRequest<{ user: AuthPrincipal }>().user;
  },
);

/** 감사 컬럼(created_by·updated_by)에 넣을 주체 ID만 꺼낸다. */
export const ActorId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): bigint | undefined => {
    return ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user?.appUserId;
  },
);
