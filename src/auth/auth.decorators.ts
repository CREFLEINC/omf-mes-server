import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';

/**
 * 토큰 없이 부를 수 있게 한다. 보호는 화이트리스트다 — 이게 붙지 않은 모든
 * 엔드포인트가 토큰을 요구하므로, 새 엔드포인트를 만들며 깜빡해도 막힌 채로 시작한다.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** 여러 개를 넘기면 **전부** 있어야 통과한다. */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export type AuthPrincipal = {
  appUserId: bigint;
  loginId: string;
  permissions: ReadonlySet<string>;
};

/** 감사 컬럼(`created_by`·`updated_by`)에 넣을 주체. */
export const ActorId = createParamDecorator((_data: unknown, ctx: ExecutionContext):
  | bigint
  | undefined => ctx.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user?.appUserId);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal =>
    ctx.switchToHttp().getRequest<{ user: AuthPrincipal }>().user,
);
