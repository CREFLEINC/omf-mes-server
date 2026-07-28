import { Module } from '@nestjs/common';

import { MasterDataModule } from '../master-data/master-data.module';
import { PopController } from './pop.controller';
import { WorkStartController } from './work-start.controller';
import { WorkStartService } from './work-start.service';

/**
 * TerminalAuthService는 AuthModule(@Global)이 export한다.
 * 자격 강제 수준은 운영정책이 정해 MasterDataModule의 resolver를 가져다 쓴다.
 */
@Module({
  imports: [MasterDataModule],
  controllers: [PopController, WorkStartController],
  providers: [WorkStartService],
})
export class PopModule {}
