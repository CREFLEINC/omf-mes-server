import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field, one } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LotRegistryService, nextMesLotNos } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { RecycleEntryView, recycleEntryView } from './recycle-entry-view';
import { RecycleEntryCreate, postRecycleEntry } from './recycle-posting';

/** 채번이 부딪히는 것은 사용자가 고칠 수 없는 값이라 다시 뽑는다(입고·조정과 같은 판정). */
const NUMBER_RETRY = 3;

/** `app.qty_t` = `numeric(20,6)` — 스케일 6 · 정수부 14. */
const QTY_SCALE = 6;
const QTY_INT_LIMIT = '100000000000000';

/** 헤더는 계약 검증 가드가 안 본다 — 컨트롤러가 꺼내 넘긴다(취급 단위 선례). */
export type RecycleEntryContext = { workerNo: string | undefined } &
  ({ actor: LogisticsWriteActor; appUserId?: never } | { appUserId: number; actor?: never });

/**
 * 재생재 등록 하나(화면 `M-01-12`). ⛔ 조회 오퍼레이션이 **0건**이라 목록·상세가 없다.
 *
 * ⭐ **안 막는 것이 설계인 자리 둘** — ⓐ 혼적 제약(`location.allow_mixed_item`·
 * `allow_mixed_lot`): 계약이 「막지 않는다가 설계다 — 화면이 경고하고 현장이 판단한다」.
 * ⓑ 품목의 구분(`item.mes_category_code`): ERP 정본 수신본에 그 칸이 없어(`W-06-05`
 * 「품목 추가는 없다」) 조이면 모든 호출이 막힌다(§4-3). ⛔ 가드를 더하면 계약 위반이다.
 */
@Injectable()
export class RecycleEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly lots: LotRegistryService,
  ) {}

  async create(input: RecycleEntryCreate, context: RecycleEntryContext): Promise<RecycleEntryView> {
    // ⚠ 사번은 **읽고 버리지만 실재는 본다** — 이 표에 사번 칸이 0개라 저장은 안 하되, 없는
    //   사번이 잔액을 늘리면 그 행의 「누가」가 영원히 빈다. ⭐ 재고를 늘리는 형제 물류 쓰기
    //   셋(`putaway-complete`·`transfer-arrive`·`stock-transfer`)이 전부 같은 갈래다 —
    //   그 일관성이 「저장 칸이 있나」보다 위다(A 리뷰 m-1 판정).
    // ⭐ 공용 판정을 «부른다» — `src/common/master/worker-no.ts` 가 그 판정을 한 벌로 모았고
    //   `worker-no.spec.ts` 가 사본을 금한다(README §6-4). 사본을 쓰면 그 불변식이 RED 다.
    await assertWorkerNoExists(this.prisma, context.workerNo);
    const axis = await this.assertWritable(input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        // ⛔ 번호 둘을 이 서비스의 `$transaction` 을 «열기 전»에 뽑는다 — 채번이 자기 트랜잭션을
        //    열므로 우리 것 «안»에서 부르면 한 요청이 커넥션을 하나 더 쥔다. 결번은 허용한다.
        // ⚠ 「한 요청이 둘을 쥐는 일이 아예 없다」는 뜻은 아니다 — HTTP 경로에서는 `runIdempotent`
        //    가 이미 트랜잭션을 열어 둔 채 이 `work()` 를 부른다(저장소 전역 패턴 · A 리뷰 m-3).
        // ⭐ 기간 축이 **본문 `businessDate`** 다 — 번호의 날짜와 원장의 영업일이 같아야 사람이
        //    두 표를 맞대 본다(입고와 같다. I-14·I-16 은 본문에 날짜가 0개라 서버 날짜였다).
        const no = await this.numbering.next('RECYCLE_ENTRY', BigInt(axis.plantId), input.businessDate);
        // LOT 번호는 **서버가 매긴다**(C-2 — 클라이언트가 정하면 오프라인 두 단말이 같은 번호를
        //    만든다) · 규칙은 `POST /trace/lots` 와 같다.
        // ⭐ 코어 것을 «부른다» — 사본을 두면 접두어·순번·공장 필터 셋이 이쪽에서만 썩고, 그
        //    사본을 재는 단언이 없어 변이 셋이 살아남았다(A 리뷰 m-2). 선례:
        //    `work-order-release.service.ts:75`. `PrismaService` 가 `Tx` 에 구조적으로 대입된다.
        const [lotNo] = await nextMesLotNos(this.prisma, axis.plantId, input.businessDate, 1);
        const recycleEntryId = await this.prisma.$transaction((tx) =>
          postRecycleEntry(tx, this.posting, this.lots, {
            input, recycleEntryNo: no, lotNo, ...axis,
            actor: context.actor ?? { appUserId: context.appUserId as number },
          }),
        );
        return await this.read(recycleEntryId, input.businessDate);
      } catch (error) {
        if (!isDuplicateNo(error)) throw error;
        if (attempt >= NUMBER_RETRY) {
          throw new ConflictException('user', '재생재 등록번호를 매기지 못했습니다. 다시 시도해 주세요.');
        }
      }
    }
  }

  private async read(recycleEntryId: bigint, businessDate: string): Promise<RecycleEntryView> {
    const row = await this.prisma.recycle_entry.findUniqueOrThrow({
      where: { recycle_entry_id: recycleEntryId }, include: { lot: true },
    });
    return recycleEntryView(row, businessDate);
  }

  /**
   * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다 — 원장까지 열고 나서 터진다.
   * ⭐ 서버가 정하는 축 둘을 여기서 **역산해 돌려준다**: 공장은 창고에서(본문에 `plantId` 가
   * 0개 · `orgAxis()` 도 창고에서 푼다 · ⛔ 위치는 창고의 자식이라 한 단계 더 멀다), 단위는
   * 품목의 기본 단위에서(계약 「단위를 본문으로 받지 않는다」).
   */
  private async assertWritable(input: RecycleEntryCreate): Promise<{ plantId: number; uomId: number }> {
    // ⛔ 본문만 보고 거를 수 있는 것은 DB 왕복 «전»에 거른다.
    assertQuantity(input.quantity);
    const [item, warehouse, location] = await Promise.all([
      this.prisma.item.findUnique({ where: { item_id: input.itemId }, select: { base_uom_id: true } }),
      this.prisma.warehouse.findUnique({ where: { warehouse_id: input.warehouseId }, select: { plant_id: true } }),
      // ⛔ 목적지는 «그 창고의 쓸 수 있는» 위치여야 한다 — 남의 창고 위치면 잔액 차원이 창고와
      //    위치가 서로 다른 곳을 가리키는 행이 되고, 비활성 위치면 현장이 더 이상 쓰지 않기로 한
      //    칸에 재고가 선다. ⭐ 형제 물류 쓰기 셋이 모두 세 칸을 함께 건다
      //    (`stock-transfer.service.ts:258-262` · `putaway-complete.service.ts:148-150` ·
      //     `transfer-arrive.service.ts:218-220`). ⚠ 계획 §5-2 는 그물을 둘만 적었다(§12-2).
      this.prisma.location.findFirst({
        where: { location_id: input.locationId, warehouse_id: input.warehouseId, is_active: true },
        select: { location_id: true },
      }),
    ]);

    const errors: ErrorItem[] = [];
    if (item === null) errors.push(field('itemId', ERROR_CODE.INVALID, '없는 품목입니다.'));
    if (warehouse === null) errors.push(field('warehouseId', ERROR_CODE.INVALID, '없는 창고입니다.'));
    if (location === null) errors.push(field('locationId', ERROR_CODE.INVALID, '이 창고의 쓸 수 있는 위치가 아닙니다.'));
    if (item === null || warehouse === null || location === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    }
    return { plantId: Number(warehouse.plant_id), uomId: Number(item.base_uom_id) };
  }
}

/**
 * ⛔ **조용한 반올림 금지**(`disposition-write.service.ts:203`). 계약 `quantity` 에 `multipleOf` 가
 * 없는데 이 값이 흘러드는 칸이 **넷 다 `numeric(20,6)`** 이다 — 막지 않으면 7째 자리가 반올림돼
 * **원장·잔액까지** 박히고(forward-only · 소급 복구 불가) `1e15` 는 계약 미선언 **500** 이 된다.
 * 근거와 실측은 계획 `docs/coverage-100/slices/I-17.md` **§4-4**.
 *
 * ⚠ `Infinity`(JSON `1e400`)는 `decimalPlaces()` 가 `NaN` 이라 자릿수 검사를 **지나간다** —
 *   정수부 검사가 그것을 잡는다. 두 검사를 하나로 줄이면 그 갈래가 샌다.
 * ⭐ 선례 — `handling-unit.service.ts:292`(둘 다 막는다) · `shipment-pick.service.ts:183`(자릿수만).
 */
function assertQuantity(quantity: number): void {
  const qty = new Prisma.Decimal(quantity);
  if (qty.decimalPlaces() > QTY_SCALE) {
    throw one(field('quantity', ERROR_CODE.RANGE, `수량은 소수점 ${QTY_SCALE}자리까지입니다.`));
  }
  if (qty.gte(QTY_INT_LIMIT)) {
    throw one(field('quantity', ERROR_CODE.RANGE, '수량은 정수 14자리를 넘을 수 없습니다.'));
  }
}

/**
 * `uq` 위반이 «번호» 때문인가 — 다른 유일 위반과 갈라야 재시도 판정이 선다.
 * ⭐ 번호가 **둘**이다(전표·LOT) — 둘 다 적는다(R-11 ⓓ). `transaction_no` 는 원장이 전표
 * 번호를 그대로 쓰는 자리다.
 */
function isDuplicateNo(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta ?? {}).target;
  return (
    Array.isArray(target) &&
    target.some((column) => ['recycle_entry_no', 'lot_no', 'transaction_no'].includes(String(column)))
  );
}
