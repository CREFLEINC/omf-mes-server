import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AllocationPackingService } from './allocation-packing.service';
import { ShipmentAllocationQueryService } from './shipment-allocation-query.service';
import { ShipmentLotAllocationView } from './shipment-allocation-view';

/**
 * ⭐⭐ **e2e 로는 «구조적으로» 못 잡는 축**만 여기서 잠근다(README §6-3 「반증 불가 부류」).
 *
 * ⓐ **잠금 «범위»** — `FOR UPDATE OF a` 를 `FOR UPDATE OF a, s` 로 넓혀도 HTTP 응답은 한 글자도
 *    안 바뀐다(실측: e2e 31건 전건 초록). 깨지는 것은 «같은 출하»의 다른 배분을 동시에 포장할
 *    때뿐이라 e2e 로는 타이밍에 기대게 된다 ⇒ **SQL 문장을 앵커로 본다**. ⛔ ⑥ 의 선례
 *    (`shipment-pick.service.spec.ts:226`)는 `/FOR UPDATE OF l/` 라 «넓히는» 변이를 못 잡았다 —
 *    이 파일은 끝을 고정해 제거와 확대를 **둘 다** 죽인다.
 * ⓑ **「행을 안 바꾼다」** — 같은 HU 재전송은 값이 같아 응답에도 표에도 흔적이 없다(그 표에
 *    `version_no`·`updated_at` 이 0개다) ⇒ **UPDATE 를 «부르지 않았는지»**를 본다.
 * ⓒ **헤더 값의 «공백»** — `X-Worker-No: '   '` 는 핸들러에 «닿지 않는다». HTTP 파서가 헤더 값의
 *    OWS 를 잘라 서버는 `''` 를 받으므로, `trim()` 을 지워도 e2e 는 31/41 전건 초록이다(리뷰
 *    실측) ⇒ **검증을 «직접» 불러** 그 축을 잠근다.
 *
 * ⛔ 이 파일은 e2e 를 대신하지 않는다 — 두 층을 같이 돌리는 것이 규칙이다(README §6-2).
 */

const ALLOCATION_ID = 901;
const WAREHOUSE_ID = 31n;
const HU_ID = 501n;
const OTHER_HU_ID = 502n;
const VIEW = { shipmentLotAllocationId: ALLOCATION_ID } as ShipmentLotAllocationView;

interface Overrides {
  currentHandlingUnitId?: bigint | null;
  huWarehouseId?: bigint | null;
  huStatusCode?: string;
}

function stub(overrides: Overrides = {}) {
  const recorded = { order: [] as string[], sql: [] as string[], got: [] as number[] };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      recorded.sql.push([...strings].join('?'));
      recorded.order.push('lock-allocation');
      return [
        {
          shipment_lot_allocation_id: BigInt(ALLOCATION_ID),
          // ⛔ `??` 로 쓰면 「이미 붙은 HU 없음(null)」이 기본값으로 접혀 그 갈래를 못 태운다.
          handling_unit_id:
            overrides.currentHandlingUnitId === undefined ? null : overrides.currentHandlingUnitId,
          current_handling_unit_no: 'HU-0001',
          warehouse_id: WAREHOUSE_ID,
        },
      ];
    },
    handling_unit: {
      findUnique: async () => {
        recorded.order.push('handling-unit');
        return {
          warehouse_id: overrides.huWarehouseId === undefined ? WAREHOUSE_ID : overrides.huWarehouseId,
          status_code: overrides.huStatusCode ?? 'OPEN',
        };
      },
    },
    shipment_lot_allocation: {
      update: async () => {
        recorded.order.push('update');
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;
  const queries = {
    get: async (id: number) => {
      recorded.order.push('read-back');
      recorded.got.push(id);
      return VIEW;
    },
  } as unknown as ShipmentAllocationQueryService;
  return { service: new AllocationPackingService(prisma, queries), recorded };
}

function pack(harness: ReturnType<typeof stub>, handlingUnitId = HU_ID): Promise<unknown> {
  return harness.service.pack(ALLOCATION_ID, { handlingUnitId: Number(handlingUnitId) }, { workerNo: 'W1' });
}

describe('배분 포장 연결 — e2e 가 못 보는 축', () => {
  it('⭐⭐ 배분 «한 행»만 잠근다 — `FOR UPDATE OF a` 로 끝난다(헤더를 더하면 깨진다)', async () => {
    const harness = stub();

    await pack(harness);

    const [lockSql] = harness.recorded.sql;
    // ⛔ 끝을 고정한다 — `OF a, s` 로 넓히면 같은 출하의 다른 배분을 잇는 스캔이 서로를 막는데,
    //   여러 배분을 연달아 포장하는 것이 `P-04-01` 의 정상 흐름이다.
    expect(lockSql.trimEnd()).toMatch(/FOR UPDATE OF a$/);
    expect(lockSql).not.toMatch(/FOR UPDATE OF a\s*,/);
    // 조인 둘은 창고와 현재 포장 번호를 푸는 길일 뿐 잠금 대상이 아니다.
    expect(lockSql).toMatch(/JOIN logistics\.shipment s/);
  });

  it('⭐ 같은 HU 를 다시 주면 UPDATE 를 «부르지 않고» 되읽기만 한다(멱등)', async () => {
    const harness = stub({ currentHandlingUnitId: HU_ID });

    await pack(harness);

    // ⛔ 값이 같은 UPDATE 라도 돌면 행이 다시 쓰인다 — 그 표에 `version_no`·`updated_at` 이 없어
    //   응답으로는 안 갈리고, e2e 는 `xmin` 으로만 본다.
    expect(harness.recorded.order).toEqual(['lock-allocation', 'handling-unit', 'read-back']);
  });

  it('붙은 HU 가 없으면 UPDATE 뒤에 되읽기다', async () => {
    const harness = stub();

    await pack(harness);

    expect(harness.recorded.order).toEqual(['lock-allocation', 'handling-unit', 'update', 'read-back']);
  });

  it('다른 HU 가 이미 붙었으면 UPDATE 도 되읽기도 «안» 한다', async () => {
    const harness = stub({ currentHandlingUnitId: OTHER_HU_ID });

    await expect(pack(harness)).rejects.toThrow('이미 다른 포장 단위에 담겼습니다');

    expect(harness.recorded.order).not.toContain('update');
    expect(harness.recorded.order).not.toContain('read-back');
  });

  it('⭐ `X-Worker-No` 가 «공백뿐»이면 400 REQUIRED 다 — e2e 로는 못 닿는 축이다', async () => {
    const harness = stub();

    // ⛔ `trim()` 을 지우면 여기서만 빨개진다 — HTTP 파서가 OWS 를 잘라 e2e 는 `''` 만 보낸다.
    const error = (await harness.service
      .pack(ALLOCATION_ID, { handlingUnitId: Number(HU_ID) }, { workerNo: '   ' })
      .catch((cause: unknown) => cause)) as ContractException;
    expect(error).toBeInstanceOf(ContractException);
    expect(error.errors).toEqual([
      { scope: 'field', field: 'X-Worker-No', code: 'REQUIRED', message: '작업자 사번 헤더가 필요합니다.' },
    ]);
    // ① 은 트랜잭션을 열기 «전»이다 — 잠금도 안 잡힌다.
    expect(harness.recorded.order).toEqual([]);
  });

  it('⭐ 되읽기는 «경로의 그 id» 로 ⑦a 를 부른다 — 목록 첫 행을 돌려주지 않는다', async () => {
    const harness = stub();

    await pack(harness);

    expect(harness.recorded.got).toEqual([ALLOCATION_ID]);
  });

  it('④⑤⑥ 은 ⑦ 보다 «먼저» 판정한다 — 다른 HU 가 붙어 있어도 창고가 널이면 400 이다', async () => {
    const harness = stub({ currentHandlingUnitId: OTHER_HU_ID, huWarehouseId: null });

    // ⛔ 순서를 뒤집으면 409 가 먼저 나가 「폐기·타창고 HU 로 덮어쓰려던 요청」이 충돌로 읽힌다.
    const error = (await pack(harness).catch((cause: unknown) => cause)) as ContractException;
    expect(error).toBeInstanceOf(ContractException);
    expect(error.errors).toEqual([
      {
        scope: 'field',
        field: 'handlingUnitId',
        code: 'INVALID',
        message: '취급 단위의 창고를 알 수 없어 연결할 수 없습니다.',
      },
    ]);
  });
});
