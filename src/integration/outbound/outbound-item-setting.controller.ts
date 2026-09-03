import { Body, Controller, Get, HttpStatus, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { OutboundItemSettingService, SettingUpdate } from './outbound-item-setting.service';

/** 송신 항목 설정. 화면은 `W-06-12`(MES→ERP 송신 I/F 정의 — 항목 on/off)가 소유한다. */
@Controller('integration/outbound-item-settings')
export class OutboundItemSettingController {
  constructor(
    private readonly settings: OutboundItemSettingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /integration/outbound-item-settings')
  async list(): Promise<unknown> {
    return { items: await this.settings.list() };
  }

  @Put()
  @Contract('PUT /integration/outbound-item-settings')
  async replace(
    @Req() request: Request,
    @Body() body: { items: SettingUpdate[] },
  ): Promise<unknown> {
    // ⚠ 계약이 저장 충돌 보호를 두지 않았다 — 「항목이 다섯인 고정 목록이고 행을 오가며
    // 편집하는 형태가 아니다」. 그래서 If-Match 가 없고 멱등 흡수만 탄다.
    return runIdempotent(this.idempotency, request, HttpStatus.OK, async () => ({
      items: await this.settings.replace(body.items, currentSession(request)?.userId),
    }));
  }
}
