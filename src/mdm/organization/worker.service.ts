import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Editability, ReferenceQuery, filter, referenceWhere } from '../../common/master';

// 현장 작업자 디렉터리는 한 공장 최대 500명을 한 장으로 읽는다.
const WORKER_DIRECTORY_MAX_SIZE = 500;

/** 계약 `Worker` 와 동형. */
interface WorkerView {
  workerId: number;
  workerNo: string;
  workerName: string;
  nameKo: string | null;
  nameVi: string | null;
  businessUnitId: number;
  plantId: number;
  departmentId: number | null;
  appUserId: number | null;
  statusCode: string;
  isActive: boolean;
}

/** 계약 `WorkerQualification` 과 동형. */
interface QualificationView {
  workerQualificationId: number;
  workerId: number;
  qualificationTypeCode: string;
  processId: number | null;
  certificateNo: string | null;
  validFrom: string;
  validTo: string | null;
  certifiedBy: number | null;
}

interface QualificationInput {
  qualificationTypeCode: string;
  processId?: number | null;
  certificateNo?: string | null;
  validFrom: string;
  validTo?: string | null;
  certifiedBy?: number | null;
}

type WorkerRow = Prisma.workerGetPayload<object>;
type QualificationRow = Prisma.worker_qualificationGetPayload<object>;

/**
 * ⛔ 계약이 못박았다 — 「기본 정보(코드·이름 원본)는 쓰기 경로가 없다. 전부 ERP 수신본이다
 * (W-06-06 §5-4). `editability.reason` 은 **항상** `RECEIVED_FROM_ERP` 로 고정한다.」
 *
 * 그래서 여기서는 참조를 세지 않는다. 세어봐야 판정이 바뀌지 않고, 「0이면 열린다」는
 * 잘못된 기대를 화면에 심는다.
 */
const WORKER_EDITABILITY: Editability = {
  codeEditable: false,
  reason: 'RECEIVED_FROM_ERP',
  referenceCount: null,
};

@Injectable()
export class WorkerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ReferenceQuery & {
      workerNo?: string;
      departmentId?: number;
      plantId?: number;
      businessUnitId?: number;
    },
  ): Promise<PagedResponse<WorkerView>> {
    const page = pageRequest(query, WORKER_DIRECTORY_MAX_SIZE);
    const where = referenceWhere(
      query,
      { code: 'worker_no', name: 'worker_name' },
      {
        ...filter('department_id', query.departmentId),
        ...filter('plant_id', query.plantId),
        ...filter('business_unit_id', query.businessUnitId),
        // `q` 는 부분 일치지만 `workerNo` 는 사번 자체다 — 정확히 맞는 것만 준다.
        ...(query.workerNo === undefined ? {} : { worker_no: query.workerNo }),
      },
    );
    const [rows, total] = await Promise.all([
      this.prisma.worker.findMany({
        where,
        orderBy: { worker_no: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.worker.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(
    workerId: number,
  ): Promise<{ worker: WorkerView; editability: Editability; versionNo: number }> {
    const row = await this.prisma.worker.findUnique({ where: { worker_id: workerId } });
    if (!row) throw new NotFoundException('없는 작업자입니다.');
    return { worker: view(row), editability: WORKER_EDITABILITY, versionNo: row.version_no };
  }

  /**
   * 다국어 명칭만 고친다 — 원본 명칭(`worker_name`)은 건드리지 않는다.
   * QA #33·#34 가 「다국어 명칭 = MES 확장 속성」으로 확정했다(2026-08-30 되살림).
   */
  async updateNameTranslation(
    workerId: number,
    version: number,
    input: { nameKo?: string | null; nameVi?: string | null },
  ): Promise<{ worker: WorkerView; versionNo: number }> {
    const updated = await this.prisma.worker.updateMany({
      where: { worker_id: workerId, version_no: version },
      data: {
        ...(input.nameKo === undefined ? {} : { name_ko: input.nameKo }),
        ...(input.nameVi === undefined ? {} : { name_vi: input.nameVi }),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(workerId, updated.count);
    const { worker, versionNo } = await this.get(workerId);
    return { worker, versionNo };
  }

  async listQualifications(
    workerId: number,
  ): Promise<{ items: QualificationView[]; versionNo: number }> {
    // ⛔ ETag 는 «작업자»의 version_no 다. worker_qualification 에는 version_no 가 없고
    // (계약이 그 사실을 적었다), 이 목록은 통째로 교체되는 작업자의 자식 컬렉션이다.
    // 한 축으로 잠가야 「자격을 바꾸는 사이 명칭이 바뀌는」 교차 갱신도 함께 걸린다.
    const { versionNo } = await this.get(workerId);
    return { items: await this.readQualifications(workerId), versionNo };
  }

  /**
   * 최종 상태를 통째로 받는다 — 개별 부여·회수가 아니다(계약 · W-06-06 §5-1).
   *
   * `worker_qualification` 에는 `is_active`·`updated_at`·`version_no` 가 없다. 계약이
   * 「물리 삭제 금지(B-4)를 적용하지 않는다」로 못박았으므로 지우고 다시 넣는다.
   */
  async replaceQualifications(
    workerId: number,
    version: number,
    qualifications: QualificationInput[],
    appUserId?: number,
  ): Promise<{ items: QualificationView[]; versionNo: number }> {
    assertQualificationsValid(qualifications);

    const items = await this.prisma.$transaction(async (tx) => {
      // 작업자 행의 version_no 를 조건에 걸어 올린다 — 자식 컬렉션의 잠금 축이다.
      const bumped = await tx.worker.updateMany({
        where: { worker_id: workerId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      await this.assertExists(workerId, bumped.count);

      await tx.worker_qualification.deleteMany({ where: { worker_id: workerId } });
      if (qualifications.length > 0) {
        await tx.worker_qualification.createMany({
          data: qualifications.map((q) => ({
            worker_id: workerId,
            qualification_type_code: q.qualificationTypeCode,
            process_id: q.processId ?? null,
            certificate_no: q.certificateNo ?? null,
            valid_from: new Date(q.validFrom),
            valid_to: q.validTo == null ? null : new Date(q.validTo),
            certified_by: q.certifiedBy ?? null,
            ...(appUserId === undefined ? {} : { created_by: appUserId }),
          })),
        });
      }
      return tx.worker_qualification.findMany({
        where: { worker_id: workerId },
        orderBy: [{ qualification_type_code: 'asc' }, { worker_qualification_id: 'asc' }],
      });
    });

    const { versionNo } = await this.get(workerId);
    return { items: items.map(qualificationView), versionNo };
  }

  private async readQualifications(workerId: number): Promise<QualificationView[]> {
    const rows = await this.prisma.worker_qualification.findMany({
      where: { worker_id: workerId },
      orderBy: [{ qualification_type_code: 'asc' }, { worker_qualification_id: 'asc' }],
    });
    return rows.map(qualificationView);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(workerId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.worker.findUnique({
      where: { worker_id: workerId },
      select: { worker_id: true },
    });
    if (!exists) throw new NotFoundException('없는 작업자입니다.');
    assertUpdated(0);
  }
}

/**
 * 쓰기 전에 본문 자체를 본다. DB 제약(`uq_worker_qualification`·
 * `ck_worker_qualification_dates`)이 어차피 막지만, 그쪽은 «어느 줄»이 문제인지 못 짚는다.
 * 통째로 교체하는 본문이라 줄 번호가 없으면 화면이 고칠 자리를 못 찾는다.
 */
function assertQualificationsValid(qualifications: QualificationInput[]): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();

  qualifications.forEach((q, index) => {
    if (q.validTo != null && q.validTo < q.validFrom) {
      errors.push({
        scope: 'field',
        field: `qualifications[${index}].validTo`,
        code: ERROR_CODE.PAIR,
        message: '만료일은 시작일보다 앞설 수 없습니다.',
      });
    }
    // uq_worker_qualification 이 COALESCE(process_id, 0) 으로 접는다 — 빈 축은 (전체 공정).
    const key = `${q.qualificationTypeCode} ${q.processId ?? 0}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    errors.push({
      scope: 'field',
      field: `qualifications[${index}].qualificationTypeCode`,
      code: ERROR_CODE.UNIQUE_VIOLATION,
      uniqueScope: ['qualificationTypeCode', 'processId'],
      message: `${first + 1}번째 줄과 같은 자격·공정입니다.`,
    });
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function view(row: WorkerRow): WorkerView {
  return {
    workerId: Number(row.worker_id),
    workerNo: row.worker_no,
    workerName: row.worker_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    businessUnitId: Number(row.business_unit_id),
    plantId: Number(row.plant_id),
    departmentId: row.department_id === null ? null : Number(row.department_id),
    appUserId: row.app_user_id === null ? null : Number(row.app_user_id),
    statusCode: row.status_code,
    isActive: row.is_active,
  };
}

/** `@db.Date` 는 날짜다 — 시각을 붙이면 계약의 `format: date` 와 어긋난다. */
function qualificationView(row: QualificationRow): QualificationView {
  return {
    workerQualificationId: Number(row.worker_qualification_id),
    workerId: Number(row.worker_id),
    qualificationTypeCode: row.qualification_type_code,
    processId: row.process_id === null ? null : Number(row.process_id),
    certificateNo: row.certificate_no,
    validFrom: row.valid_from.toISOString().slice(0, 10),
    validTo: row.valid_to === null ? null : row.valid_to.toISOString().slice(0, 10),
    certifiedBy: row.certified_by === null ? null : Number(row.certified_by),
  };
}
