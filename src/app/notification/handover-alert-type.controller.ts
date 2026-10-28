import { Controller, Get } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { HANDOVER_ALERT_TYPES } from '../../core/notification/handover-alert-types';

/** 인계 작업 종류 — 로그인한 누구나 읽는다(W-CO-03·12·13 이 이름을 합친다). 기존 `/app/notification-events` 와 별개다. */
@Controller('app/handover-alert-types')
export class HandoverAlertTypeController {
  @Get()
  @Contract('GET /app/handover-alert-types')
  types(): { items: { alertTypeCode: string; name: string; nameVi: string; description: string; targetTypeCode: string }[] } {
    return {
      items: HANDOVER_ALERT_TYPES.map((type) => ({
        alertTypeCode: type.alertTypeCode,
        name: type.name,
        nameVi: type.nameVi,
        description: type.description,
        targetTypeCode: type.aggregateTypeCode,
      })),
    };
  }
}
