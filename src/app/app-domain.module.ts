import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

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
import { AttachmentController } from './attachment/attachment.controller';
import { AttachmentService } from './attachment/attachment.service';
import { DocumentIssueQueryService } from './document-issue/document-issue-query.service';
import { DocumentIssueSummaryMiddleware } from './document-issue/document-issue-summary.middleware';
import { DocumentIssueSummaryService } from './document-issue/document-issue-summary.service';
import { DocumentIssueController } from './document-issue/document-issue.controller';
import { NoticeController } from './notice/notice.controller';
import { NoticeService } from './notice/notice.service';
import { NotificationController } from './notification/notification.controller';
import { NotificationPreviewController } from './notification/notification-preview.controller';
import { NotificationPreviewService } from './notification/notification-preview.service';
import { NotificationQueryService } from './notification/notification-query.service';
import { NotificationWriteController } from './notification/notification-write.controller';
import { NotificationWriteService } from './notification/notification-write.service';
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
  imports: [
    PrismaModule,
    IdempotencyModule,
    AuthModule,
    ApprovalModule,
    NumberingModule,
  ],
  controllers: [
    PermissionController,
    RoleController,
    AppUserController,
    AttachmentController,
    DocumentIssueController,
    OperationPolicyController,
    NoticeController,
    NotificationController,
    NotificationPreviewController,
    NotificationWriteController,
    ApprovalRouteController,
    ApprovalRequestController,
  ],
  providers: [
    RoleService,
    RolePermissionService,
    AppUserService,
    UserAssignmentService,
    AttachmentService,
    DocumentIssueQueryService,
    DocumentIssueSummaryService,
    OperationPolicyService,
    NoticeService,
    NotificationQueryService,
    NotificationPreviewService,
    NotificationWriteService,
    ApprovalRouteService,
    ApprovalRequestService,
  ],
})
export class AppDomainModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DocumentIssueSummaryMiddleware).forRoutes({
      path: 'app/document-issues/summary',
      method: RequestMethod.GET,
    });
  }
}
