import { ErrorCode, ErrorItem, screenError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 사용 중지를 막는 것은 **지금 살아 있는 것**뿐이다.
 *
 * 창고를 가리키는 FK 는 15개지만 여기서 보는 것은 둘이다. 과거 전표(입출고·출하·이송·
 * 반납·실사·원장라인)까지 세면 **한 번이라도 쓰인 창고가 영영 중지되지 않는다** —
 * 코드 편집을 잠글 때 쓰는 참조 건수(`countWarehouseReferences`)와 판단이 갈리는 지점이다.
 * 그쪽은 「과거가 가리키니 코드를 못 바꾼다」가 맞고, 이쪽은 틀리다.
 *
 * 적치 규칙은 막지 않는다 — 운영 설정이라 창고가 죽으면 저절로 무의미해진다.
 *
 * 미결 전표(입고 예정 등)는 막아야 맞지만 아직 판정할 수 없다. `status_code` 가
 * `VarChar` 이고 어느 값이 미결인지 정하는 코드그룹이 `mdm.code_value` 에 없다 —
 * 물류 모듈이 아직 없기 때문이다. 없는 근거로 지어내지 않고 남겨둔다.
 */
export async function checkDeactivable(
  prisma: PrismaService,
  warehouseId: bigint,
): Promise<ErrorItem[]> {
  const [stock, activeLocation] = await Promise.all([
    // 행이 있는지가 아니라 **수량이 남았는지**를 본다. 다 빠져나가도 잔량 0 인 행은 남는다.
    // 생성 컬럼 available_qty 는 예약·피킹분이 빠져 0 이하로 내려갈 수 있어 쓰지 않는다.
    prisma.inventory_balance.findFirst({
      where: {
        warehouse_id: warehouseId,
        OR: [
          { on_hand_qty: { gt: 0 } },
          { reserved_qty: { gt: 0 } },
          { picked_qty: { gt: 0 } },
          { blocked_qty: { gt: 0 } },
        ],
      },
      select: { inventory_balance_id: true },
    }),
    // 창고만 중지하면 로케이션은 제 목록에 살아 보인다 — 갈 수 없는 자리가 남는다.
    prisma.location.findFirst({
      where: { warehouse_id: warehouseId, is_active: true },
      select: { location_id: true },
    }),
  ]);

  return [
    ...(stock
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '재고가 남아 있어 중지할 수 없습니다. 먼저 재고를 모두 옮기거나 출고하십시오.',
          ),
        ]
      : []),
    ...(activeLocation
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '사용 중인 로케이션이 있어 중지할 수 없습니다. 로케이션을 먼저 중지하십시오.',
          ),
        ]
      : []),
  ];
}
