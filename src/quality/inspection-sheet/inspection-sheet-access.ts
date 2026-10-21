import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { currentTerminal } from '../../auth/terminal-context';
import { oaOnly, oaPlantsInScope } from '../../core/inspection-sheet';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 제품 검사표·검사표 기준은 OA 공장 범위만 쓴다(omf-all-around#89 · 장부 P-102 · 담당자 결정 2026-10-21).
 * 관리웹은 계정의 데이터 범위가 덮는 OA 공장, POP 은 단말 공장이다 — 단말 공장이 OA 인지는 단말 범위가 먼저 본다
 * (`terminal-inspection-sheet-scope.ts`). 범위에 OA 공장이 없으면 403 「이 화면은 OA 사업부 전용입니다」.
 */
@Injectable()
export class InspectionSheetAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** 이 요청이 쓸 수 있는 OA 공장 id 들 — 비면 403 이다. */
  async plantsOf(request: Request): Promise<bigint[]> {
    const terminal = currentTerminal(request);
    if (terminal !== undefined) return [terminal.plantId];
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
    const plants = await oaPlantsInScope(this.prisma, session.scopes);
    if (plants.length === 0) throw oaOnly();
    return plants;
  }

  /** 검사표의 LOT 공장이 범위 안이어야 한다. 없는 검사표는 404. */
  async assertSheet(id: number, plants: readonly bigint[]): Promise<void> {
    const sheet = await this.prisma.inspection_sheet.findUnique({
      where: { inspection_sheet_id: id },
      select: { lot: { select: { plant_id: true } } },
    });
    if (sheet === null) throw new NotFoundException('없는 검사표입니다.');
    if (!plants.includes(sheet.lot.plant_id)) throw oaOnly();
  }

  /** 열 시리얼의 LOT 공장이 범위 안이어야 한다. 없는 시리얼은 여기서 막지 않는다 — 서비스의 400 이다. */
  async assertSerial(serialNo: string, plants: readonly bigint[]): Promise<void> {
    const serial = await this.prisma.serial_number.findUnique({
      where: { serial_no: serialNo },
      select: { lot: { select: { plant_id: true } } },
    });
    if (serial !== null && !plants.includes(serial.lot.plant_id)) throw oaOnly();
  }
}
