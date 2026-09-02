import { Controller, Get } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PERMISSIONS, Permission } from '../../common/permissions';

/**
 * 기능 권한 «후보» 목록 — 권한 격자의 **열**을 만든다.
 *
 * ⛔ 표가 아니라 앱 상수다(`src/common/permissions/permissions.ts` 가 근거 넷을 적었다).
 * 그래서 이 컨트롤러에 서비스도 Prisma 도 없다 — 상수를 그대로 낸다.
 *
 * ⭐ 쪽을 나누지 않는다(계약) — 목록이 화면 수만큼으로 닫혀 있고, 쪽이 나뉘면 둘째 쪽을
 * 못 받았을 때 격자에서 열이 조용히 사라진다.
 */
@Controller('app/permissions')
export class PermissionController {
  @Get()
  @Contract('GET /app/permissions')
  list(): { items: readonly Permission[] } {
    return { items: PERMISSIONS };
  }
}
