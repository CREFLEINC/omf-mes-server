import { Module } from '@nestjs/common';

import { MasterDataModule } from '../master-data/master-data.module';
import { RoleController, UserController } from './access.controller';
import { RoleService } from './role.service';
import { UserService } from './user.service';

@Module({
  imports: [MasterDataModule],
  controllers: [RoleController, UserController],
  providers: [RoleService, UserService],
})
export class AccessModule {}
