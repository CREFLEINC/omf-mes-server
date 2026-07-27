import { Module } from '@nestjs/common';

import { MasterDataModule } from '../master-data/master-data.module';
import { RoleController, UserController } from './access.controller';
import { RoleService } from './role.service';
import { UserService } from './user.service';

/**
 * 접근권한 도메인 — 정본 물리 모델의 `app` 스키마.
 *
 * 범위는 **인가(authorization)** 다: 계정·역할·기능권한·데이터 접근범위.
 * 정본 모델에 자격증명(비밀번호·토큰·세션) 저장소가 없어 **인증(authentication)은 미구현**이며,
 * 여기서 부여한 권한을 강제하는 가드도 아직 없다(README '인증 미결' 참조).
 */
@Module({
  imports: [MasterDataModule],
  controllers: [RoleController, UserController],
  providers: [RoleService, UserService],
})
export class AccessModule {}
