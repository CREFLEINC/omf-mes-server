import { ErrorCode, ErrorItem, screenError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 자리를 다시 쓰려면 **위쪽이 살아 있어야** 한다 — 중지가 안쪽을 보는 것과 정반대다.
 *
 * 창고가 꺼져 있으면 안 된다. K 가 「사용 중인 자리가 있으면 창고를 못 끈다」로 정했으니,
 * 꺼진 창고 안에 켜진 자리를 만들면 그 규칙이 뒤에서 깨진다.
 *
 * 부모 자리가 꺼져 있어도 안 된다. 위에서부터 켜야 한다 — 중지가 아래에서부터 끄는 것과
 * 짝을 이룬다.
 *
 * 하위 자리는 함께 켜지 않는다. 끌 때 하나씩 껐으니 켤 때도 골라서 켜야 한다.
 */
export async function checkActivable(
  prisma: PrismaService,
  location: { warehouse_id: bigint; parent_location_id: bigint | null },
): Promise<ErrorItem[]> {
  const [warehouse, parent] = await Promise.all([
    prisma.warehouse.findUnique({
      where: { warehouse_id: location.warehouse_id },
      select: { is_active: true },
    }),
    location.parent_location_id === null
      ? null
      : prisma.location.findUnique({
          where: { location_id: location.parent_location_id },
          select: { is_active: true },
        }),
  ]);

  return [
    ...(warehouse?.is_active
      ? []
      : [
          screenError(
            ErrorCode.STATE_LOCKED,
            '중지된 창고의 자리는 다시 사용할 수 없습니다. 창고를 먼저 사용 상태로 되돌리십시오.',
          ),
        ]),
    ...(location.parent_location_id !== null && !parent?.is_active
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '상위 로케이션이 중지 상태입니다. 위에서부터 사용 상태로 되돌리십시오.',
          ),
        ]
      : []),
  ];
}

/**
 * 사용 중지를 막는 것은 **지금 살아 있는 것**뿐이다 — 창고와 같은 판단이다.
 *
 * 로케이션을 가리키는 FK 는 26곳이지만 여기서 보는 것은 둘이다. 과거 전표까지 세면
 * **한 번이라도 쓰인 자리가 영영 중지되지 않는다** — 코드 편집을 잠글 때 쓰는
 * 참조 건수(`LOCATION_REFERENCES`)와 판단이 갈리는 지점이다.
 *
 * 적치 규칙(`putaway_rule`)은 막지 않는다. 운영 설정이라 자리가 죽으면 무의미해진다.
 *
 * 미결 전표는 아직 판정할 수 없다. `status_code` 가 `VarChar` 이고 어느 값이 미결인지
 * 정하는 코드그룹이 `mdm.code_value` 에 없다 — 물류 모듈이 아직 없기 때문이다.
 */
export async function checkDeactivable(
  prisma: PrismaService,
  locationId: bigint,
): Promise<ErrorItem[]> {
  const [stock, activeChild] = await Promise.all([
    // 행이 있는지가 아니라 **수량이 남았는지**를 본다. 다 빠져나가도 잔량 0 인 행은 남는다.
    prisma.inventory_balance.findFirst({
      where: {
        location_id: locationId,
        OR: [
          { on_hand_qty: { gt: 0 } },
          { reserved_qty: { gt: 0 } },
          { picked_qty: { gt: 0 } },
          { blocked_qty: { gt: 0 } },
        ],
      },
      select: { inventory_balance_id: true },
    }),
    // 아래에서부터 꺼야 한다. 부모만 끄면 자식은 제 목록에 살아 보인다.
    prisma.location.findFirst({
      where: { parent_location_id: locationId, is_active: true },
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
    ...(activeChild
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '사용 중인 하위 로케이션이 있어 중지할 수 없습니다. 아래에서부터 중지하십시오.',
          ),
        ]
      : []),
  ];
}
