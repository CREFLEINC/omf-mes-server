import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { PermissionGuard } from './permission.guard';

@Module({ providers: [{ provide: APP_GUARD, useClass: PermissionGuard }] })
export class PermissionModule {}
