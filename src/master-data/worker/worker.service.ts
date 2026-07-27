import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, worker, worker_qualification } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import { DepartmentService } from './department.service';
import {
  CreateQualificationDto,
  CreateWorkerDto,
  QualificationQueryDto,
  UpdateWorkerDto,
  WorkerQueryDto,
} from './worker.dto';

/** 작업자 마스터 — mdm.worker + mdm.worker_qualification */
@Injectable()
export class WorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly departments: DepartmentService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateWorkerDto, actor?: bigint): Promise<worker> {
    await this.codes.assertValid('WORKER_STATUS', dto.statusCode);

    orConflict(
      await this.prisma.worker.findUnique({ where: { worker_no: dto.workerNo } }),
      `이미 존재하는 사번입니다: ${dto.workerNo}`,
    );

    const [plant, unit, departmentId] = await Promise.all([
      this.org.findPlant(dto.legalEntityCode, dto.plantCode),
      this.org.findBusinessUnit(dto.legalEntityCode, dto.businessUnitCode),
      this.departments.resolveId(dto.departmentCode),
    ]);

    return this.prisma.worker.create({
      data: {
        worker_no: dto.workerNo,
        worker_name: dto.workerName,
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        department_id: departmentId,
        status_code: dto.statusCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: WorkerQueryDto): Promise<PageDto<worker>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };
    if (query.departmentCode) extra.department = { department_code: query.departmentCode };
    if (query.statusCode) extra.status_code = query.statusCode;

    const where = baseWhere(query, ['worker_no', 'worker_name'], extra) as Prisma.workerWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.worker.findMany({
        where,
        orderBy: { worker_no: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.worker.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  /** 단건 조회 — 소속 부서와 보유 자격을 함께 준다. */
  async findOne(workerNo: string) {
    const found = await this.prisma.worker.findUnique({
      where: { worker_no: workerNo },
      include: {
        department: true,
        worker_qualification: { orderBy: { valid_from: 'desc' } },
      },
    });
    return orFail(found, `작업자(${workerNo})`);
  }

  async update(workerNo: string, dto: UpdateWorkerDto, actor?: bigint): Promise<worker> {
    const found = await this.getWorker(workerNo);
    await this.codes.assertValid('WORKER_STATUS', dto.statusCode);

    const departmentId =
      dto.departmentCode === undefined
        ? undefined
        : await this.departments.resolveId(dto.departmentCode);

    return this.prisma.worker.update({
      where: { worker_id: found.worker_id },
      data: {
        worker_name: dto.workerName,
        department_id: departmentId,
        status_code: dto.statusCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 비활성화(퇴직 처리 등).
   *
   * 보유 자격은 이력이라 지우지 않고, 자격이 있다고 비활성화를 막지도 않는다.
   * 작업자를 참조하는 나머지는 전부 트랜잭션(작업세션·실적·검사·피킹 등)이라
   * '미완료 작업이 있으면 막는다'는 판정은 생산 모듈과 함께 붙인다.
   */
  async deactivate(workerNo: string, actor?: bigint): Promise<void> {
    const found = await this.getWorker(workerNo);

    await this.prisma.worker.update({
      where: { worker_id: found.worker_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  // ── 자격 ──────────────────────────────────────────────────────────────

  async addQualification(
    workerNo: string,
    dto: CreateQualificationDto,
    actor?: bigint,
  ): Promise<worker_qualification> {
    const found = await this.getWorker(workerNo);
    await this.codes.assertValid('QUALIFICATION_TYPE', dto.qualificationTypeCode);

    if (dto.validTo && dto.validTo < dto.validFrom) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }

    const processId = await this.resolveProcess(dto.processCode);

    // DB의 유니크 인덱스는 COALESCE(process_id, 0)을 쓴다 — Prisma 모델로 표현되지 않으므로
    // 앱에서 먼저 확인한다. 경합으로 빠져나간 건은 DB가 막고 P2002 → 409로 변환된다.
    orConflict(
      await this.prisma.worker_qualification.findFirst({
        where: {
          worker_id: found.worker_id,
          qualification_type_code: dto.qualificationTypeCode,
          process_id: processId,
          valid_from: dto.validFrom,
        },
      }),
      `같은 시작일의 자격이 이미 있습니다: ${workerNo}.${dto.qualificationTypeCode}`,
    );

    return this.prisma.worker_qualification.create({
      data: {
        worker_id: found.worker_id,
        qualification_type_code: dto.qualificationTypeCode,
        process_id: processId,
        certificate_no: dto.certificateNo ?? null,
        valid_from: dto.validFrom,
        valid_to: dto.validTo ?? null,
        created_by: actor,
      },
    });
  }

  async findQualifications(
    workerNo: string,
    query: QualificationQueryDto,
  ): Promise<worker_qualification[]> {
    const found = await this.getWorker(workerNo);

    const where: Prisma.worker_qualificationWhereInput = { worker_id: found.worker_id };
    if (query.qualificationTypeCode) {
      where.qualification_type_code = query.qualificationTypeCode;
    }
    if (query.validOn) {
      // 기준일에 유효한 자격 — 종료일이 없으면 무기한으로 본다.
      where.valid_from = { lte: query.validOn };
      where.OR = [{ valid_to: null }, { valid_to: { gte: query.validOn } }];
    }

    return this.prisma.worker_qualification.findMany({
      where,
      orderBy: [{ valid_from: 'desc' }],
    });
  }

  /** 자격 삭제 — 비활성 플래그가 없는 이력 테이블이라 물리 삭제한다. */
  async removeQualification(workerNo: string, qualificationId: bigint): Promise<void> {
    const found = await this.getWorker(workerNo);
    const row = orFail(
      await this.prisma.worker_qualification.findFirst({
        where: { worker_qualification_id: qualificationId, worker_id: found.worker_id },
      }),
      `자격(${qualificationId})`,
    );

    await this.prisma.worker_qualification.delete({
      where: { worker_qualification_id: row.worker_qualification_id },
    });
  }

  // ── 내부 ──────────────────────────────────────────────────────────────

  private async getWorker(workerNo: string): Promise<worker> {
    return orFail(
      await this.prisma.worker.findUnique({ where: { worker_no: workerNo } }),
      `작업자(${workerNo})`,
    );
  }

  private async resolveProcess(processCode?: string): Promise<bigint | null> {
    if (!processCode) return null;

    const found = orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
    return found.process_id;
  }
}
