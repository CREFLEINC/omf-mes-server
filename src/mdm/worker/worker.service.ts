import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractBadRequest, ErrorCode, ErrorItem, fieldError } from '../../common/errors/contract-error';
import { checkDateRange, findDuplicates } from '../collection-replace';
import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkerQualificationRowDto } from './worker-qualification.dto';
import { workerEditability } from './worker.editability';
import { toQualification, toWorker } from './worker.mapper';
import { WorkerQueryDto } from './worker.query.dto';

type Schemas = components['schemas'];

@Injectable()
export class WorkerService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: WorkerQueryDto): Promise<{
    items: Schemas['Worker'][];
    page: Schemas['PageMeta'];
  }> {
    const F = Prisma.WorkerScalarFieldEnum;
    const where: Prisma.workerWhereInput = {};

    if (!query.includeInactive) where.is_active = true;
    if (query.departmentId) where.department_id = BigInt(query.departmentId);
    if (query.plantId) where.plant_id = BigInt(query.plantId);
    if (query.businessUnitId) where.business_unit_id = BigInt(query.businessUnitId);
    if (query.q) {
      where.OR = [F.worker_no, F.worker_name].map((column) => ({
        [column]: { contains: query.q, mode: 'insensitive' as const },
      }));
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.worker.findMany({
        where,
        // worker_no 가 전역 유일키라 한 칸으로 페이지가 흔들리지 않는다.
        orderBy: { worker_no: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.worker.count({ where }),
    ]);

    return { items: rows.map(toWorker), page: { page: query.page, size: query.size, total } };
  }

  /** 읽기 전용이다 — 쓰기 경로가 없어 `ETag` 도 내리지 않는다. */
  async findOne(workerId: bigint): Promise<Schemas['WorkerDetailResponse']> {
    const row = await this.prisma.worker.findUnique({ where: { worker_id: workerId } });
    if (!row) throw new NotFoundException(`작업자(${workerId})를 찾을 수 없습니다.`);

    return { worker: toWorker(row), editability: workerEditability() };
  }

  async findQualifications(
    workerId: bigint,
  ): Promise<Schemas['WorkerQualificationListResponse']> {
    await this.assertWorker(workerId);

    const rows = await this.prisma.worker_qualification.findMany({
      where: { worker_id: workerId },
      // uq_worker_qualification 을 따라 정렬해 페이지 없이도 차례가 고정된다.
      orderBy: [
        { qualification_type_code: 'asc' },
        { process_id: { sort: 'asc', nulls: 'first' } },
        { valid_from: 'asc' },
      ],
    });

    return { items: rows.map(toQualification) };
  }

  /**
   * 최종 상태를 통째로 받아 한 트랜잭션으로 지우고 넣는다(공유계약 B-6).
   * 품목 부속 3종과 같은 형태다 — `is_active` 도 `version_no` 도 없어 낙관적 잠금이 없다.
   */
  async replaceQualifications(
    workerId: bigint,
    rows: WorkerQualificationRowDto[],
    actorId: bigint,
  ): Promise<Schemas['WorkerQualificationListResponse']> {
    await this.assertWorker(workerId);

    const errors = await this.validate(rows);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    await this.prisma.$transaction([
      this.prisma.worker_qualification.deleteMany({ where: { worker_id: workerId } }),
      this.prisma.worker_qualification.createMany({
        data: rows.map((row) => ({
          worker_id: workerId,
          qualification_type_code: row.qualificationTypeCode,
          process_id: row.processId ? BigInt(row.processId) : null,
          certificate_no: row.certificateNo ?? null,
          valid_from: new Date(row.validFrom),
          valid_to: row.validTo ? new Date(row.validTo) : null,
          certified_by: row.certifiedBy ? BigInt(row.certifiedBy) : null,
          created_by: actorId,
        })),
      }),
    ]);

    return this.findQualifications(workerId);
  }

  /**
   * `qualificationTypeCode` 는 계약이 「공통코드」라 했지만 **값 목록이 아직 없다**(§8-5) —
   * 대조할 코드그룹이 `mdm.code_value` 에 없어 형태만 본다.
   * `certifiedBy` 도 FK 가 없어 무엇을 가리키는지 근거가 없다(#64). 둘 다 미결이다.
   */
  private async validate(rows: WorkerQualificationRowDto[]): Promise<ErrorItem[]> {
    const errors: ErrorItem[] = [];

    rows.forEach((row, index) => {
      errors.push(...checkDateRange(index, row.validFrom, row.validTo, 'validTo'));
    });

    // uq_worker_qualification 은 COALESCE(process_id, 0) 으로 접는다 — 비운 것과 null 이
    // 같은 자리다(공유계약 A-7).
    errors.push(
      ...findDuplicates(
        rows,
        (row) => `${row.qualificationTypeCode}|${row.processId ?? 0}|${row.validFrom}`,
        'qualificationTypeCode',
      ),
    );

    const processIds = [...new Set(rows.map((row) => row.processId).filter((id): id is number => !!id))];
    if (processIds.length > 0) {
      const found = await this.prisma.process.count({
        where: { process_id: { in: processIds.map(BigInt) } },
      });
      if (found !== processIds.length) {
        errors.push(fieldError('processId', ErrorCode.RANGE, '없는 공정입니다.'));
      }
    }

    return errors;
  }

  /** 없는 작업자의 자격을 다루면 404 다 — 빈 목록을 주면 화면이 작업자가 있는 줄 안다. */
  private async assertWorker(workerId: bigint): Promise<void> {
    const found = await this.prisma.worker.findUnique({
      where: { worker_id: workerId },
      select: { worker_id: true },
    });
    if (!found) throw new NotFoundException(`작업자(${workerId})를 찾을 수 없습니다.`);
  }
}
