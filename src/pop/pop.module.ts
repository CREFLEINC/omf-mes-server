import { Module } from '@nestjs/common';

import { MasterDataModule } from '../master-data/master-data.module';
import { PopController } from './pop.controller';
import { ProductionResultController } from './production-result.controller';
import { ProductionResultService } from './production-result.service';
import { WorkStartController } from './work-start.controller';
import { WorkStartService } from './work-start.service';

/**
 * TerminalAuthService는 AuthModule(@Global)이 export한다.
 * 운영정책 resolver(자격 강제 수준)와 채번 발번기는 MasterDataModule에서 가져다 쓴다.
 */
@Module({
  imports: [MasterDataModule],
  controllers: [PopController, WorkStartController, ProductionResultController],
  providers: [WorkStartService, ProductionResultService],
})
export class PopModule {}
