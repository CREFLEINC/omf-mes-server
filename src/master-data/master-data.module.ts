import { Module } from '@nestjs/common';

import { CommonCodeModule } from './common-code/common-code.module';

/** 기준정보(마스터) 도메인 — 개념모델 v2 §1 */
@Module({
  imports: [CommonCodeModule],
})
export class MasterDataModule {}
