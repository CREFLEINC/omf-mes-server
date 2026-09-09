import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  ConflictException,
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
  one,
} from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlingUnitQueryService } from './handling-unit-query.service';
import { HU_STATUS_OPEN } from './handling-unit-status';
import { assertWorkerNo } from './handling-unit-worker';
import { HandlingUnitDetailView } from './handling-unit-view';

/** 계약 `HandlingUnitContentUpsert` — 등록의 `contents[]` 와 PR ④ 의 치환이 같은 모양이다. */
export interface HandlingUnitContentUpsert {
  itemId: number;
  lotId: number;
  qty: number;
  uomId: number;
}

/** 계약 `HandlingUnitCreate`. required 는 `handlingUnitTypeCode` 하나뿐이다. */
export interface HandlingUnitCreate {
  handlingUnitTypeCode: string;
  parentHandlingUnitId?: number | null;
  warehouseId?: number | null;
  locationId?: number | null;
  contents?: HandlingUnitContentUpsert[];
}

/** 헤더는 계약 검증 가드가 안 본다 — 컨트롤러가 꺼내 서비스에 넘긴다(이동 도착 선례). */
export interface HandlingUnitContext {
  workerNo: string | undefined;
  appUserId: number;
}

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(조정·이동과 같은 판정). */
const NUMBER_RETRY = 3;

/**
 * 부모 사슬을 거슬러 오를 때의 반복 상한. 계층 «깊이»의 상한이 아니다 — `P-04-01` §8
 * 미결 4(포장 계층 깊이)가 미정이라 깊이는 열어 둔다(계획 §4-3 기준 1). 이미 순환인
 * 데이터를 만났을 때 영영 도는 것을 막는 방어일 뿐이다.
 */
const PARENT_WALK_LIMIT = 200;

/** `app.qty_t` = `numeric(20,6)` — 스케일 6 · 정수부 14. */
const QTY_SCALE = 6;
const QTY_INT_LIMIT = '100000000000000';

/**
 * 취급 단위 «등록» 하나(PR ③). 구성 치환은 PR ④, 포장 확정은 PR ⑤ 몫이다.
 * ⛔ 원장을 안 부른다 — `inventory_balance` 차원에 `handling_unit_id` 가 없다(계획 §2-5·§3-5).
 */
@Injectable()
export class HandlingUnitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: HandlingUnitQueryService,
    private readonly numbering: NumberingService,
  ) {}

  /**
   * ⭐ 반환이 `{ versionNo, view }` 다 — `runIdempotent` 는 `outcome.body` «만» 돌려주고
   * `setEtag` 를 안 부른다. 계약은 201 에 ETag 를 선언했고 응답 본문에 `version_no` 가
   * 없으므로, 버전을 캐시 본문에 실어야 **재전송 응답에서도** 토큰을 만들 수 있다
   * (`idempotency.service.ts` 가 `response_body` 를 JSON 으로 되살린다 · 계획 §4-1).
   */
  async create(
    input: HandlingUnitCreate,
    context: HandlingUnitContext,
  ): Promise<{ versionNo: number; view: HandlingUnitDetailView }> {
    await assertWorkerNo(this.prisma, context.workerNo);
    await assertCodeValues(this.prisma, [
      { field: 'handlingUnitTypeCode', value: input.handlingUnitTypeCode, groupCode: CODE_GROUP },
    ]);
    const contents = input.contents ?? [];
    assertNoDuplicateContent(contents);
    assertContentQty(contents);
    await this.assertReferences(input, contents);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호는 `$transaction` 을 «열기 전»에 뽑는다 — 열린 트랜잭션 안에서 부르면 한
        //    요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2.md R-2). 결번은 허용한다.
        // ⚠ 기간 축은 «서버 UTC 오늘»이다 — `HandlingUnitCreate` 에 날짜 칸이 0개다.
        //    하노이(UTC+7) 00:00–07:00 의 등록은 전날 번호를 받는다(통보 144 ⓒ). 이 표는
        //    `business_date` 를 안 실어 공유계약 C-8 자리가 아니다.
        const periodDate = new Date().toISOString().slice(0, 10);
        const handlingUnitNo = await this.numbering.next('HANDLING_UNIT', null, periodDate);
        const id = await this.prisma.$transaction((tx) =>
          this.write(tx, input, contents, handlingUnitNo, context.appUserId),
        );
        const detail = await this.queries.get(Number(id));
        return {
          versionNo: detail.versionNo,
          view: { handlingUnit: detail.handlingUnit, contents: detail.contents },
        };
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException(
            'user',
            '취급단위번호를 매기지 못했습니다. 다시 시도해 주세요.',
          );
        }
      }
    }
  }

  /** 헤더 → 구성 N. 한 트랜잭션이다. 부모 순환 검사가 그 첫 문장이다(계획 §4 ⑥). */
  private async write(
    tx: Prisma.TransactionClient,
    input: HandlingUnitCreate,
    contents: HandlingUnitContentUpsert[],
    handlingUnitNo: string,
    appUserId: number,
  ): Promise<bigint> {
    await assertParentAcyclic(tx, input.parentHandlingUnitId ?? null);
    const header = await tx.handling_unit.create({
      data: {
        handling_unit_no: handlingUnitNo,
        handling_unit_type_code: input.handlingUnitTypeCode,
        // 계약이 셋 다 `[integer,null]` 로 널을 명시했다 — 서버가 기본값을 도출하지 않는다(§4-4).
        parent_handling_unit_id: input.parentHandlingUnitId ?? null,
        warehouse_id: input.warehouseId ?? null,
        location_id: input.locationId ?? null,
        status_code: HU_STATUS_OPEN,
        created_by: appUserId,
        updated_by: appUserId,
        handling_unit_content: {
          create: contents.map((line) => ({
            item_id: line.itemId,
            lot_id: line.lotId,
            qty: line.qty,
            uom_id: line.uomId,
            created_by: appUserId,
          })),
        },
      },
      select: { handling_unit_id: true },
    });
    return header.handling_unit_id;
  }

  /**
   * 참조 존재 확인. ⚠ **404 를 안 낸다** — 계약이 이 오퍼레이션에 404 를 선언하지 않았고
   * 없는 부모·창고·위치는 본문이 틀린 것이다 ⇒ 400 `INVALID`(I-3·I-5 와 같은 가름 · §4-4).
   */
  private async assertReferences(
    input: HandlingUnitCreate,
    contents: HandlingUnitContentUpsert[],
  ): Promise<void> {
    const parentId = input.parentHandlingUnitId ?? null;
    const warehouseId = input.warehouseId ?? null;
    const locationId = input.locationId ?? null;

    const [parent, warehouse, location, items, lots, uoms] = await Promise.all([
      parentId === null
        ? 1
        : this.prisma.handling_unit.count({ where: { handling_unit_id: parentId } }),
      warehouseId === null
        ? 1
        : this.prisma.warehouse.count({ where: { warehouse_id: warehouseId } }),
      locationId === null ? 1 : this.prisma.location.count({ where: { location_id: locationId } }),
      this.prisma.item.findMany({
        where: { item_id: { in: contents.map((c) => c.itemId) } },
        select: { item_id: true },
      }),
      this.prisma.lot.findMany({
        where: { lot_id: { in: contents.map((c) => c.lotId) } },
        select: { lot_id: true },
      }),
      this.prisma.uom.findMany({
        where: { uom_id: { in: contents.map((c) => c.uomId) } },
        select: { uom_id: true },
      }),
    ]);

    const itemIds = new Set(items.map((row) => Number(row.item_id)));
    const lotIds = new Set(lots.map((row) => Number(row.lot_id)));
    const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
    const errors: ErrorItem[] = [];
    const missing = (name: string): number =>
      errors.push(field(name, ERROR_CODE.INVALID, '없는 식별자입니다.'));

    if (parent === 0) missing('parentHandlingUnitId');
    if (warehouse === 0) missing('warehouseId');
    if (location === 0) missing('locationId');
    contents.forEach((line, index) => {
      if (!itemIds.has(line.itemId)) missing(`contents[${index}].itemId`);
      if (!lotIds.has(line.lotId)) missing(`contents[${index}].lotId`);
      if (!uomIds.has(line.uomId)) missing(`contents[${index}].uomId`);
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

/** 계약 `x-code-key` 가 가리키는 그룹 — 값 목록은 데이터가 갖는다(공유계약 G-32). */
const CODE_GROUP = 'HANDLING_UNIT_TYPE';

/**
 * 순환 방지는 **서버 몫**이다 — 물리 CHECK 는 `parent <> self` 하나뿐이라 `A→B→A` 를 안
 * 막는다(`ck_handling_unit_parent` 원문 · 계획 §4-3). 등록되는 새 행은 아직 아무의 부모도
 * 아니므로 여기서 잡는 것은 **이미 순환인 부모 사슬**이다.
 * ⛔ «깊이» 상한은 두지 않는다 — `P-04-01` §8 미결 4 가 미정이라 3단 이상을 막으면 안 된다.
 * ⭐ 이미 지난 조상을 다시 만나면 그 자리에서 400 `INVALID` 다(500 도 무한 루프도 아니다).
 * ⚠ `PARENT_WALK_LIMIT` 은 «깊이» 상한이 아니라 **작업량 상한**이다 — 종료는 `seen` 이
 *   이미 보장하므로 이 상한은 「한 요청이 조상 질의를 200회 넘게 하지 않는다」는 뜻뿐이다.
 *   그래서 201단짜리 «정상» 사슬도 거절된다(현장에 그런 중첩은 없다 · PR #522 리뷰 Minor-1).
 */
export async function assertParentAcyclic(
  tx: Prisma.TransactionClient,
  parentId: number | null,
): Promise<void> {
  const seen = new Set<number>();
  let cursor = parentId;
  for (let step = 0; cursor !== null; step += 1) {
    if (seen.has(cursor)) {
      throw one(field('parentHandlingUnitId', ERROR_CODE.INVALID, '상위 취급 단위가 순환합니다.'));
    }
    // ⚠ 여기는 순환이 «아니다» — 사슬이 너무 길 뿐이라 그렇게 말한다(리뷰 Minor-1).
    if (step >= PARENT_WALK_LIMIT) {
      throw one(
        field('parentHandlingUnitId', ERROR_CODE.INVALID, '상위 취급 단위 사슬이 너무 깊습니다.'),
      );
    }
    seen.add(cursor);
    const row = await tx.handling_unit.findUnique({
      where: { handling_unit_id: cursor },
      select: { parent_handling_unit_id: true },
    });
    // 존재 확인은 `assertReferences` 가 이미 400 으로 냈다 — 사슬 위쪽이 없으면 끝이다.
    if (row === null) return;
    cursor = row.parent_handling_unit_id === null ? null : Number(row.parent_handling_unit_id);
  }
}

/**
 * 요청 배열 안의 `(itemId, lotId)` 중복. ⛔ 물리 `uq_handling_unit_content` 에 맡기지
 * 않는다 — P2002 는 어느 줄이 겹쳤는지 못 알려 준다(계약 「같은 취급 단위 안에서
 * 품목·LOT 조합은 한 번만 나온다」).
 *
 * ⚠ 배열 이름이 두 오퍼레이션에서 다르다 — 등록은 `contents`, 치환(PR ④)은 `items` 다.
 *   `field` 가 요청 본문의 «그 자리»를 짚어야 화면이 어느 줄인지 안다.
 */
export function assertNoDuplicateContent(
  contents: HandlingUnitContentUpsert[],
  arrayField = 'contents',
): void {
  const seen = new Set<string>();
  contents.forEach((line, index) => {
    const key = `${line.itemId} ${line.lotId}`;
    if (seen.has(key)) {
      throw one(
        field(
          `${arrayField}[${index}]`,
          ERROR_CODE.UNIQUE_VIOLATION,
          '같은 품목·LOT 조합이 두 번 실렸습니다.',
        ),
      );
    }
    seen.add(key);
  });
}

/**
 * 수량의 «자릿수». 물리는 `app.qty_t` = `numeric(20,6)` 이라 7째 자리가 **조용히 반올림**된다
 * (실측: `10.0000005::numeric(20,6)` → `10.000001`). 마이그는 forward-only 라 그렇게 접힌 값은
 * **소급 복구가 안 된다** ⇒ 저장 «전»에 400 `RANGE` 로 거절한다.
 *
 * ⭐ 저장소 규칙이다 — `disposition-write.service.ts:203` 「⛔ 조용한 반올림 금지」 ·
 *   `nonconformance-rules.ts:43` `assertQtyPrecision`(선례 둘). 계약은 `qty` 에
 *   `exclusiveMinimum: 0` 뿐 `multipleOf` 가 없어 **서버가 막는 자리**다.
 * ⚠ 정수부 상한도 같이 본다 — `1e15` 는 `numeric(20,6)` 이 못 담아 지금은 «계약 미선언 500» 이다.
 *
 * ⛔ `nonconformance-rules.ts` 의 것을 **import 하지 않는다** — 이 저장소에 도메인 간 import 가
 *   **0건**이라 여기서 첫 사례를 만들지 않는다. 같은 규칙이 두 자리에 있는 사실은 마감표에 적었다.
 */
export function assertContentQty(
  contents: HandlingUnitContentUpsert[],
  arrayField = 'contents',
): void {
  contents.forEach((line, index) => {
    const qty = new Prisma.Decimal(line.qty);
    if (qty.decimalPlaces() > QTY_SCALE) {
      throw one(
        field(
          `${arrayField}[${index}].qty`,
          ERROR_CODE.RANGE,
          `수량은 소수점 ${QTY_SCALE}자리까지입니다.`,
        ),
      );
    }
    // ⛔ `Infinity`(JSON `1e400`)는 `decimalPlaces()` 가 NaN 이라 위를 지난다 — 여기서 잡힌다.
    if (qty.gte(QTY_INT_LIMIT)) {
      throw one(
        field(
          `${arrayField}[${index}].qty`,
          ERROR_CODE.RANGE,
          '수량은 정수 14자리를 넘을 수 없습니다.',
        ),
      );
    }
  });
}

/** `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다. */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return Array.isArray(target) && target.some((column) => String(column) === 'handling_unit_no');
}
