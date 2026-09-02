import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { OptimisticLockGuard } from './optimistic-lock.guard';

@Module({ providers: [{ provide: APP_GUARD, useClass: OptimisticLockGuard }] })
export class OptimisticLockModule {}
