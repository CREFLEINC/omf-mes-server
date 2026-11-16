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

/** 제품 LOT OQC 스캔 조회 — 관리웹 OQC 판정 화면의 「LOT 스캔」이 시리얼 대신 LOT 번호로 의뢰를 연다. */
@Controller('quality/oqc-lots')
export class OqcLotController {
  constructor(private readonly oqcSerials: OqcSerialQueryService) {}

  @Get(':lotNo')
  @Contract('GET /quality/oqc-lots/{lotNo}')
  scan(@Param('lotNo') lotNo: string) {
    return this.oqcSerials.scanLot(lotNo);
  }
}
