import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../common/idempotency';
import { ApprovalModule } from '../core/approval';
import { NumberingModule } from '../core/numbering';
import { PrismaModule } from '../prisma/prisma.module';
import { ApprovalRequestController } from './approval/approval-request.controller';
import { ApprovalRequestService } from './approval/approval-request.service';
import { ApprovalRouteController } from './approval/approval-route.controller';
import { ApprovalRouteService } from './approval/approval-route.service';
import { AppUserController } from './access/app-user.controller';
import { AppUserService } from './access/app-user.service';
import { PermissionController } from './access/permission.controller';
import { NoticeController } from './notice/notice.controller';
import { NoticeService } from './notice/notice.service';
import { OperationPolicyController } from './policy/operation-policy.controller';
import { OperationPolicyService } from './policy/operation-policy.service';
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
  // AuthModule 이 CredentialService 를 내보낸다 — 내 비밀번호 변경이 그것을 쓴다.
  // ApprovalModule(core) 은 결재함의 「현재 단계」 판정이 :approve/:reject 와 같은
  // 함수여야 해서 끌어온다(I-1.md R-2).
  imports: [PrismaModule, IdempotencyModule, AuthModule, ApprovalModule, NumberingModule],
  controllers: [
    PermissionController,
    RoleController,
    AppUserController,
    OperationPolicyController,
    NoticeController,
    ApprovalRouteController,
    ApprovalRequestController,
  ],
  providers: [
    RoleService,
    RolePermissionService,
    AppUserService,
    UserAssignmentService,
    OperationPolicyService,
    NoticeService,
    ApprovalRouteService,
    ApprovalRequestService,
  ],
})
export class AppDomainModule {}
