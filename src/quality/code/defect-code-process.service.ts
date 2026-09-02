import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

/** 계약 `DefectCodeProcess` 와 동형. `processName` 은 조인이다 — 화면 왕복을 없앤다. */
interface MappingView {
  defectCodeId: number;
  processId: number;
  processName: string;
}

/**
 * 불량코드-공정 매핑(N:M). 결정 12 를 되살린 자원이다(2026-08-30).
 *
 * ⛔ 부여·회수 형태다 — `created_at`·`created_by` 만 있고 `version_no` 가 없다.
 * 그래서 낙관적 잠금이 없고, 해제는 `DELETE` 로 즉시 반영한다(화면의 셀 토글).
 */
@Injectable()
export class DefectCodeProcessService {
  constructor(private readonly prisma: PrismaService) {}

  async list(defectCodeId: number): Promise<MappingView[]> {
    await this.load(defectCodeId);
    const rows = await this.prisma.defect_code_process.findMany({
      where: { defect_code_id: defectCodeId },
      include: { process: { select: { process_name: true } } },
      orderBy: { process_id: 'asc' },
    });
    return rows.map((row) => ({
      defectCodeId: Number(row.defect_code_id),
      processId: Number(row.process_id),
      processName: row.process.process_name,
    }));
  }

  /**
   * ⛔ 「**상세 코드만 매핑한다**(대분류는 전사 고정 축)」(계약). 대분류에 공정을 걸면
   * POP 불량 입력 화면이 대분류를 목록에 올려, 작업자가 현상을 고르지 않고 넘어간다.
   */
  async add(defectCodeId: number, processId: number, actorId?: number): Promise<MappingView> {
    const defectCode = await this.load(defectCodeId);
    if (defectCode.parent_defect_code_id === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.INVALID,
          message: '대분류에는 공정을 매핑할 수 없습니다 — 상세 코드에만 겁니다.',
        },
      ]);
    }

    const process = await this.prisma.process.findUnique({
      where: { process_id: processId },
      select: { process_id: true, process_name: true },
    });
    if (!process) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'field',
          field: 'processId',
          code: ERROR_CODE.INVALID,
          message: '없는 공정입니다.',
        },
      ]);
    }

    const existing = await this.prisma.defect_code_process.findUnique({
      where: { defect_code_id_process_id: { defect_code_id: defectCodeId, process_id: processId } },
      select: { defect_code_process_id: true },
    });
    if (existing) {
      // ⚠ 이 자리의 409 는 계약이 `ErrorResponse` 로 선언했다 — 저장 충돌이 아니라
      // 「같은 항목이 이미 있다」라 `ConflictResponse` 계열이 아니다(계약 실측 2건 중 하나).
      throw new ContractException(HttpStatus.CONFLICT, [
        {
          scope: 'field',
          field: 'processId',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope: ['defectCodeId', 'processId'],
          message: '이미 매핑된 공정입니다.',
        },
      ]);
    }

    await this.prisma.defect_code_process.create({
      data: {
        defect_code_id: defectCodeId,
        process_id: processId,
        ...(actorId === undefined ? {} : { created_by: actorId }),
      },
    });
    return { defectCodeId, processId, processName: process.process_name };
  }

  async remove(defectCodeId: number, processId: number): Promise<void> {
    const removed = await this.prisma.defect_code_process.deleteMany({
      where: { defect_code_id: defectCodeId, process_id: processId },
    });
    if (removed.count === 0) throw new NotFoundException('없는 매핑입니다.');
  }

  private async load(
    defectCodeId: number,
  ): Promise<{ parent_defect_code_id: bigint | null }> {
    const row = await this.prisma.defect_code.findUnique({
      where: { defect_code_id: defectCodeId },
      select: { parent_defect_code_id: true },
    });
    if (!row) throw new NotFoundException('없는 불량코드입니다.');
    return row;
  }
}
