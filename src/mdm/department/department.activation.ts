import { ErrorCode, ErrorItem, screenError } from '../../common/errors/contract-error';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 부서를 다시 쓰려면 **위쪽이 살아 있어야** 한다 — 중지가 안쪽을 보는 것과 정반대다.
 *
 * 상위 부서가 꺼져 있으면 안 된다. 위에서부터 켜야 한다 — 중지가 아래에서부터 끄는 것과
 * 짝을 이룬다.
 *
 * 사업부는 있을 때만 본다. 부서는 사업부에 속하지 않을 수 있다(nullable).
 *
 * 하위 부서는 함께 켜지 않는다. 끌 때 하나씩 껐으니 켤 때도 골라서 켜야 한다.
 */
export async function checkActivable(
  prisma: PrismaService,
  department: { parent_department_id: bigint | null; business_unit_id: bigint | null },
): Promise<ErrorItem[]> {
  const [parent, businessUnit] = await Promise.all([
    department.parent_department_id === null
      ? null
      : prisma.department.findUnique({
          where: { department_id: department.parent_department_id },
          select: { is_active: true },
        }),
    department.business_unit_id === null
      ? null
      : prisma.business_unit.findUnique({
          where: { business_unit_id: department.business_unit_id },
          select: { is_active: true },
        }),
  ]);

  return [
    ...(department.parent_department_id !== null && !parent?.is_active
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '상위 부서가 중지 상태입니다. 위에서부터 사용 상태로 되돌리십시오.',
          ),
        ]
      : []),
    ...(department.business_unit_id !== null && !businessUnit?.is_active
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '중지된 사업부의 부서는 다시 사용할 수 없습니다. 사업부를 먼저 되돌리십시오.',
          ),
        ]
      : []),
  ];
}

/**
 * 사용 중지를 막는 것은 **지금 살아 있는 것**뿐이다 — 창고·로케이션과 같은 판단이다.
 *
 * 부서를 가리키는 FK 는 7곳이지만 여기서 보는 것은 셋이다. 과거 기록(불량 기록의
 * 「책임 부서」, 예외 처리의 「담당 부서」, 결재선 단계)까지 세면 **한 번이라도 책임진
 * 부서가 영영 중지되지 않는다** — 코드 편집을 잠글 때 쓰는 참조 건수와 판단이 갈린다.
 *
 * 창고·로케이션에서 「재고 잔량」 자리에 오는 것이 **사람**이다. 부서에 사용자나
 * 작업자가 남아 있는데 중지하면 소속 없는 사람이 생긴다.
 */
export async function checkDeactivable(
  prisma: PrismaService,
  departmentId: bigint,
): Promise<ErrorItem[]> {
  const [activeChild, appUser, worker] = await Promise.all([
    // 아래에서부터 꺼야 한다. 부모만 끄면 자식은 제 목록에 살아 보인다.
    prisma.department.findFirst({
      where: { parent_department_id: departmentId, is_active: true },
      select: { department_id: true },
    }),
    prisma.app_user.findFirst({
      where: { department_id: departmentId, is_active: true },
      select: { app_user_id: true },
    }),
    prisma.worker.findFirst({
      where: { department_id: departmentId, is_active: true },
      select: { worker_id: true },
    }),
  ]);

  return [
    ...(activeChild
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '사용 중인 하위 부서가 있어 중지할 수 없습니다. 아래에서부터 중지하십시오.',
          ),
        ]
      : []),
    ...(appUser || worker
      ? [
          screenError(
            ErrorCode.STATE_LOCKED,
            '이 부서에 속한 사용자·작업자가 있어 중지할 수 없습니다. 먼저 소속을 옮기십시오.',
          ),
        ]
      : []),
  ];
}
