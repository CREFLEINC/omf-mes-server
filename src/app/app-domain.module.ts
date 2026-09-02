import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../common/idempotency';
import { PrismaModule } from '../prisma/prisma.module';
import { AppUserController } from './access/app-user.controller';
import { AppUserService } from './access/app-user.service';
import { PermissionController } from './access/permission.controller';
import { RolePermissionService } from './access/role-permission.service';
import { RoleController } from './access/role.controller';
import { RoleService } from './access/role.service';
import { UserAssignmentService } from './access/user-assignment.service';

/**
 * 계약 최상위 경로 `/app` — 사용자·역할·권한, 알림, 공지, 첨부, 결재, 문서 발행.
 * (`docs/server-architecture.md` §1 「모듈 배치는 계약 경로를 따른다」)
 *
 * ⚠ 이름이 `AppModule` 이 아닌 이유는 Nest 루트 모듈(`src/app.module.ts`)과 부딪히기
 * 때문이다. 루트는 애플리케이션 전체이고 이쪽은 «도메인 하나»다.
 *
 * ⚠ `/app/sessions` 는 여기 있지 않다 — 인증 자신이라 `AuthModule` 이 소유한다.
 */
@Module({
  imports: [PrismaModule, IdempotencyModule],
  controllers: [PermissionController, RoleController, AppUserController],
  providers: [RoleService, RolePermissionService, AppUserService, UserAssignmentService],
})
export class AppDomainModule {}
