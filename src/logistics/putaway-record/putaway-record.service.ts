import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { currentTerminal } from '../../auth/terminal-context';
import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { plantToday } from '../../common/period/plant-local-period';
import { PrismaService } from '../../prisma/prisma.service';
import { locationPaths } from '../putaway-direct/location-verdict';
import { PutawayRecordView, RecordScope, loadPutawayRecords, recordView } from './putaway-record.query';

export interface PutawayRecordQuery { scope: RecordScope; businessDate: string; page?: number; size?: number }

/** 공장 오늘에서 며칠 전까지 보이는가(FR-006 — 오늘 포함 7일). */
const DAYS_BACK = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PDA 적치 기록(M-01-14 · 피처 011) — 「내 기록」은 `X-Worker-No` 의 작업자, 「이 단말」은 토큰의 단말. 결과는 언제나 단말 공장 안이다.
 * 다른 작업자·단말 id 는 받지 않는다(research R-5).
 */
@Injectable()
export class PutawayRecordService {
  constructor(private readonly prisma: PrismaService) {}

  async list(request: Request, query: PutawayRecordQuery): Promise<PagedResponse<PutawayRecordView>> {
    const terminal = currentTerminal(request);
    // 단말 허용 목록이 POP 을 막는다. 계정 세션은 화면 권한을 통과해 여기 닿으므로 직접 막는다 — MOBILE 단말 전용이다.
    if (terminal === undefined || terminal.terminalTypeCode !== 'MOBILE') {
      throw new ContractException(HttpStatus.UNAUTHORIZED, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: 'PDA 단말에서만 볼 수 있습니다.' }]);
    }
    const actorId = query.scope === 'TERMINAL' ? terminal.terminalId : await this.workerOf(request, terminal.plantId);
    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: terminal.plantId }, select: { timezone_code: true } });
    assertWithinDays(query.businessDate, await plantToday(this.prisma, Number(terminal.plantId)));

    const page = pageRequest({ page: query.page, size: query.size });
    const rows = await loadPutawayRecords(this.prisma, {
      plantId: terminal.plantId, timezone: plant.timezone_code, businessDate: query.businessDate, scope: query.scope, actorId,
    });
    const shown = rows.slice(page.skip, page.skip + page.take);
    const paths = await locationPaths(this.prisma, shown.map((row) => row.location_id));
    return pagedResponse(shown.map((row) => recordView(row, paths.get(row.location_id) ?? row.location_code)), rows.length, page);
  }

  /** 「내 기록」의 작업자 — 이 공장 재직 작업자만(읽기라 단말 범위 검사가 사번을 심지 않는다). */
  private async workerOf(request: Request, plantId: bigint): Promise<bigint> {
    const workerNo = request.header('X-Worker-No') ?? '';
    const worker = workerNo === '' ? null : await this.prisma.worker.findFirst({
      where: { worker_no: workerNo, plant_id: plantId, is_active: true }, select: { worker_id: true },
    });
    if (worker === null) throw one(field('X-Worker-No', ERROR_CODE.INVALID, '이 공장 작업자 사번이 필요합니다.'));
    return worker.worker_id;
  }
}

function assertWithinDays(businessDate: string, today: string): void {
  const back = Math.round((Date.parse(today) - Date.parse(businessDate)) / DAY_MS);
  if (Number.isNaN(back) || back < 0 || back > DAYS_BACK) {
    throw one(field('businessDate', ERROR_CODE.RANGE, `공장 오늘(${today})부터 ${String(DAYS_BACK)}일 전까지만 볼 수 있습니다.`));
  }
}
