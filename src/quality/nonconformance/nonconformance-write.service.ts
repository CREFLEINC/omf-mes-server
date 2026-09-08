import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DispositionRequest, NonconformanceCreate, SEVERITY_GROUP, assertCreateShape, assertDispositionRequestShape } from './nonconformance-rules';
import { NONCONFORMANCE_INCLUDE, NonconformanceView, nonconformanceView } from './nonconformance-view';

/** 계약 `ShipmentConflictResponse.code` enum 5값 중 이 둘이 쓰는 셋. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const DUPLICATE_KEY = 'DUPLICATE_KEY';
const INVALID_STATE = 'INVALID_STATE';
/** 채번 문서 유형 — `DEFAULT_PREFIX.NONCONFORMANCE = 'NC'`(PR ④). */
const DOCUMENT_TYPE = 'NONCONFORMANCE';
const STATUS_COLUMN = 'quality.nonconformance.status_code';

/**
 * ⭐⭐ `POST /quality/nonconformances`(등록) · `POST …/{id}:request-disposition`(의뢰) — **심장 A**.
 * 원장도 재고도 안 지나지만 **한 트랜잭션**이다(B-8) — 등록은 헤더 한 행과 `nonconformance_lot`
 * N행이 함께 서거나 함께 없어야 한다. 하나만 서면 「대상 LOT 이 없는 부적합」이 남아 처분
 * 판정(PR ⑦)이 옮길 대상을 못 찾는다.
 * ⛔ **LOT 을 옮기지 않는다** — 계약이 등록·의뢰에 전이를 안 적었고 `lot_hold` 도 안 건다. 그
 *    필연으로 `nonconformance_lot` 의 before/after 가 **같은 값**이 된다(§1-4-1).
 * ⛔ **`business_date` 를 다루지 않는다** — 이 두 표에 그 칸이 0개다(C-8 무관).
 */
@Injectable()
export class NonconformanceWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly documentState: DocumentStateService,
  ) {}

  /**
   * 등록 — 201. ⭐ **갈래 순서가 판정이다**(§3-4): 코드값 → 본문 형식 → 참조 존재(400) → 중복
   * 부적합(409) → tx. ⛔ **404 를 안 낸다** — 계약이 이 오퍼레이션에 404 를 «선언하지 않았다»
   * (§1-1). 없는 `itemId`·`lotId` 는 전부 400 `INVALID` 다.
   */
  async create(body: NonconformanceCreate, appUserId: number): Promise<NonconformanceView> {
    // (0) 코드값 대조는 트랜잭션 «밖»이다 — 코드 표를 읽는 커넥션을 업무 tx 가 쥐지 않는다.
    await assertCodeValues(this.prisma, [{ field: 'severityCode', value: body.severityCode, groupCode: SEVERITY_GROUP }]);
    // (1) 본문 형식 — 통과하면 `lots[]` 가 공유하는 단위 하나를 돌려준다.
    const uomId = assertCreateShape(body);
    // (2) 참조 존재 → (3) 중복 부적합. 이 순서가 판정이다 — 없는 LOT 이면 「열린 부적합」을 물을 대상이 없다.
    const lotStatus = await this.assertReferences(body, uomId);
    await this.assertNoOpenNonconformance(body.lots.map((lot) => BigInt(lot.lotId)));

    // (4) ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 코어 규약(`numbering.service.ts`): 열린 tx
    //     안에서 부르면 한 요청이 커넥션을 둘 쥐어 `P2024` 로 죽는다. 대가는 롤백 때의 결번이고
    //     계약이 번호의 연속을 요구하지 않는다(선례 `goods-issue.service.ts:68`).
    const openedAt = new Date();
    const nonconformanceNo = await this.numbering.next(DOCUMENT_TYPE, null, openedAt.toISOString().slice(0, 10));

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.nonconformance.create({
        data: {
          nonconformance_no: nonconformanceNo,
          item_id: BigInt(body.itemId),
          ...idColumn('work_order_id', body.workOrderId),
          ...idColumn('inspection_result_id', body.inspectionResultId),
          severity_code: body.severityCode,
          description: body.description,
          ...idColumn('responsible_department_id', body.responsibleDepartmentId),
          // ⛔ 서버가 연다 — 계약이 `statusCode`·`openedAt` 을 본문에서 «받지 않는다»(B-6).
          status_code: 'NOT_REQUESTED',
          opened_at: openedAt,
          created_by: BigInt(appUserId),
          updated_by: BigInt(appUserId),
        },
        select: { nonconformance_id: true },
      });
      await tx.nonconformance_lot.createMany({
        data: body.lots.map((lot) => ({
          nonconformance_id: created.nonconformance_id,
          lot_id: BigInt(lot.lotId),
          affected_qty: new Prisma.Decimal(lot.affectedQty),
          uom_id: BigInt(lot.uomId),
          // ⭐ 등록이 LOT 을 안 옮기므로 둘이 **같은 값**이고, LOT «마다» 다르다(원천이 갈려 출발이 셋으로 섞인다).
          quality_status_before_code: lotStatus.get(BigInt(lot.lotId)) as string,
          quality_status_after_code: lotStatus.get(BigInt(lot.lotId)) as string,
          created_by: BigInt(appUserId),
        })),
      });
      // 응답은 조회와 «같은 매퍼»를 탄다 — 등록 직후 화면이 목록에서 볼 값과 갈리지 않는다.
      return tx.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: created.nonconformance_id }, include: NONCONFORMANCE_INCLUDE });
    });
    return nonconformanceView(row);
  }

  /**
   * 의뢰 — 200. ⭐ **순서가 판정이다**(§3-2): 존재(404) → 본문 형식(400) → 상태 전이(409
   * `INVALID_STATE`) → 조건부 UPDATE(409 `VERSION_CONFLICT` · **토큰 비교가 트랜잭션 «끝»이다**).
   * ⭐ 실제로 바뀌는 것은 `status_code` 와 `version_no` 둘뿐이다 — 본문 3칸은 담을 데가 0이라
   *    형식만 보고 버린다(§1-3 · 통보 089 §5).
   */
  async requestDisposition(
    nonconformanceId: number,
    version: number,
    body: DispositionRequest,
    appUserId: number,
  ): Promise<{ view: NonconformanceView; versionNo: number }> {
    const id = BigInt(nonconformanceId);
    return this.prisma.$transaction(async (tx) => {
      // (1) 존재 — ⭐ 계약이 «이» 오퍼레이션에는 404 를 선언했다(등록과 다르다).
      const found = await tx.nonconformance.findUnique({ where: { nonconformance_id: id }, include: NONCONFORMANCE_INCLUDE });
      if (found === null) throw new NotFoundException('없는 부적합입니다.');
      // (2) 본문 형식 — 단위 대조가 «조회와 같은 매퍼»가 낸 값을 본다(두 곳에 두면 조회가 보는
      //     단위와 쓰기가 대조하는 단위가 조용히 갈린다).
      assertDispositionRequestShape(body, nonconformanceView(found).uomId);
      // (3) 상태 전이 — `NOT_REQUESTED` 밖은 409 다(⛔ 400 이 아니다 · `W-04-07` §6 「이미 의뢰됨」).
      const transition = this.assertRequestable(found.status_code);
      // (4) ⭐ 조건부 UPDATE — 0행이면 그 사이 누가 판을 올린 것이다.
      const updated = await tx.nonconformance.updateMany({
        where: { nonconformance_id: id, version_no: version },
        data: { status_code: transition.to, version_no: { increment: 1 }, updated_by: BigInt(appUserId), updated_at: new Date() },
      });
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(found.version_no) });
      const row = await tx.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: id }, include: NONCONFORMANCE_INCLUDE });
      return { view: nonconformanceView(row), versionNo: row.version_no };
    });
  }

  /**
   * 참조 존재 — ⛔ **전부 400 `INVALID`** 다(계약이 등록에 404 를 안 선언했다 · 안 막으면 FK 위반이
   * 필드 이름 없는 400 이 된다). 돌려주는 것은 LOT 마다의 **현재 상태**다(before/after 의 원천).
   */
  private async assertReferences(body: NonconformanceCreate, uomId: number): Promise<Map<bigint, string>> {
    const lotIds = body.lots.map((lot) => BigInt(lot.lotId));
    const [item, uom, lots, workOrder, inspectionResult, department] = await Promise.all([
      this.prisma.item.findUnique({ where: { item_id: BigInt(body.itemId) }, select: { item_id: true } }),
      this.prisma.uom.findUnique({ where: { uom_id: BigInt(uomId) }, select: { uom_id: true } }),
      this.prisma.lot.findMany({ where: { lot_id: { in: lotIds } }, select: { lot_id: true, status_code: true } }),
      findOptional(body.workOrderId, (id) => this.prisma.work_order.findUnique({ where: { work_order_id: id }, select: { work_order_id: true } })),
      findOptional(body.inspectionResultId, (id) => this.prisma.inspection_result.findUnique({ where: { inspection_result_id: id }, select: { inspection_result_id: true } })),
      findOptional(body.responsibleDepartmentId, (id) => this.prisma.department.findUnique({ where: { department_id: id }, select: { department_id: true } })),
    ]);

    if (item === null) throw invalidReference('itemId', body.itemId);
    if (uom === null) throw invalidReference('lots[0].uomId', uomId);
    const statusById = new Map(lots.map((lot) => [lot.lot_id, lot.status_code]));
    const missing = body.lots.findIndex((lot) => !statusById.has(BigInt(lot.lotId)));
    if (missing >= 0) throw invalidReference(`lots[${missing}].lotId`, body.lots[missing].lotId);
    if (workOrder === null) throw invalidReference('workOrderId', body.workOrderId);
    if (inspectionResult === null) throw invalidReference('inspectionResultId', body.inspectionResultId);
    if (department === null) throw invalidReference('responsibleDepartmentId', body.responsibleDepartmentId);
    return statusById;
  }

  /**
   * ⭐ 같은 LOT 에 **열린** 부적합이 있으면 409 `DUPLICATE_KEY` — 근거는 후보 목록의
   * `withoutNonconformanceOnly`(「같은 대상을 두 번 등록하는 것을 막는 축」)와
   * `DispositionCandidate.nonconformanceId` 가 **단수**인 것이다(§1-6). ⛔ 판정은 `status_code` 가
   * 아니라 **`closed_at IS NULL`** 로만 한다 — 종결된 것만 있는 LOT 은 다시 등록된다.
   * ⛔ `conflictingLotId` 를 안 싣는다 — `ShipmentConflictResponse` 에 그 칸이 없다(넷뿐).
   */
  private async assertNoOpenNonconformance(lotIds: bigint[]): Promise<void> {
    const open = await this.prisma.nonconformance_lot.findFirst({
      where: { lot_id: { in: lotIds }, nonconformance: { closed_at: null } },
      select: { lot_id: true },
      orderBy: { nonconformance_lot_id: 'asc' },
    });
    if (open === null) return;
    throw new ConflictException('user', `이미 열려 있는 부적합이 있습니다. (LOT ${open.lot_id})`, { code: DUPLICATE_KEY });
  }

  /**
   * ⛔ 코어 `assertTransition` 은 계열 봉투를 모른다 — `code` 없이 409 를 낸다. 출하 계열이 그
   * 칸을 **required** 로 두므로 여기서 씌운다. 전이표는 그대로 정본이다 — `from`·`to` 를 안 베낀다.
   */
  private assertRequestable(currentStatus: string): { to: string } {
    try {
      return this.documentState.assertTransition(STATUS_COLUMN, 'nonconformance-request-disposition', currentStatus);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      throw new ConflictException('user', error.conflict.message, { code: INVALID_STATE });
    }
  }
}

/** 계약이 `null` 을 허용한 선택 FK 셋 — 안 보냈으면 칸을 «안 만들고», `null` 이면 비운다. */
function idColumn(column: string, value: number | null | undefined): Record<string, bigint | null> {
  return value === undefined ? {} : { [column]: value === null ? null : BigInt(value) };
}

/** 값이 없으면 조회 자체를 안 한다 — 「안 보낸 칸」이 「없는 참조」로 읽히면 안 된다(`'skip'`). */
async function findOptional(value: number | null | undefined, find: (id: bigint) => Promise<object | null>): Promise<object | null | 'skip'> {
  return value === undefined || value === null ? 'skip' : find(BigInt(value));
}

function invalidReference(name: string, value: number | null | undefined): ReturnType<typeof one> {
  return one(field(name, ERROR_CODE.INVALID, `없는 대상입니다: ${value}`));
}
