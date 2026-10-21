import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminalQualityReadScope } from '../../auth/terminal-quality-read-scope';
import { Contract } from '../../common/contract';
import { OqcSerialQueryService } from './oqc-serial-query.service';

/** 시리얼 OQC 스캔 조회(omf-all-around#68 · 장부 P-89). POP 은 단말 공장의 시리얼·의뢰만. */
@Controller('quality/oqc-serials')
export class OqcSerialController {
  constructor(private readonly oqcSerials: OqcSerialQueryService) {}

  @Get(':serialNo')
  @Contract('GET /quality/oqc-serials/{serialNo}')
  scan(@Req() request: Request, @Param('serialNo') serialNo: string) {
    return this.oqcSerials.scan(serialNo, currentTerminalQualityReadScope(request));
  }
}
