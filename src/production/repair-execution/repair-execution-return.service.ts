import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
// ⛔ 새 사본을 만들지 않는다(I-25 R-6) — PR ② 가 세운 선례 그대로다.
import { assertWorkerNo } from '../work-session/work-session.service';
import { RepairExecutionView, repairExecutionView } from './repair-execution-view';

type Tx = Prisma.TransactionClient;
type LockedRepair = { started_at: Date; returned_at: Date | null };
/**
 * ⚠ 선례와 갈리는 자리 — `work-session-end.service.ts:44-47` 은 같은 상황(이미 닫힌 구간)을
 * 400 `STATE_LOCKED` 로 낸다. 여기서 409 로 가른 것은 **계약이 409 를 선언했기 때문**이다
 * (⌜충돌 — 이미 반출됐다⌝ · `ProductionConflictResponse.code` enum 안 · §6-1).
 */
const INVALID_STATE = 'INVALID_STATE';

/** 계약 `RepairExecutionReturn` — required 둘. enum 2값은 ajv 가 이미 강제한다(§1-5). */
export interface RepairExecutionReturn {
  returnedAt: string;
  repairResultCode: string;
}

/**
 * 수리 반출 등록 — 열린 구간을 «닫는다»(I-25 §6 · `work-session-end.service.ts` 의 직역 복제).
 *
 * ⛔ `worker_no` 를 **덮지 않는다** — 계약이 그 칸을 ⌜**투입한** 사람⌝ 이라 적었고 반출자
 *    사번을 담을 칸이 없다. 헤더는 검사만 하고 버린다(§6-1 · 「알려둘 것」 ⓓ).
 * ⛔ `version_no`·`updated_at` 칸이 이 표에 **없다** — 올릴 것이 없고 If-Match 도 계약에 없다.
 * ⛔ `reintroduced_lot_id` 를 건드리지 않는다(§0 자리 4) · 원장 0 · 상태기계 0.
 */
@Injectable()
export class RepairExecutionReturnService {
  constructor(private readonly prisma: PrismaService) {}

  /** `return` 은 예약어라 메서드 이름을 `close` 로 둔다 — 하는 일은 구간 닫기다. */
  async close(
    repairExecutionId: number,
    body: RepairExecutionReturn,
    workerNo: string | undefined,
  ): Promise<RepairExecutionView> {
    await assertWorkerNo(this.prisma, workerNo);
    return this.prisma.$transaction(async (tx: Tx) => {
      const locked = await lockRepairExecution(tx, repairExecutionId);
      // 다른 키로 온 두 번째 반출이다 — 재로드해도 풀리지 않는 업무 거부라 `conflictCause='user'`.
      if (locked.returned_at !== null) {
        throw new ConflictException('user', '이미 반출된 수리 건입니다.', { code: INVALID_STATE });
      }
      const returnedAt = new Date(body.returnedAt);
      // CHECK `ck_repair_execution_period` 앞당김 — **경계 포함**(`>=` 라 같은 시각은 통과한다).
      if (returnedAt < locked.started_at) {
        throw one(field('returnedAt', ERROR_CODE.RANGE, '투입 시각보다 앞설 수 없습니다.'));
      }
      const row = await tx.repair_execution.update({
        where: { repair_execution_id: BigInt(repairExecutionId) },
        // ⭐ 둘을 «함께» 쓴다 — CHECK `ck_repair_execution_return` 이 짝을 강제한다.
        data: { returned_at: returnedAt, repair_result_code: body.repairResultCode },
      });
      return repairExecutionView(row);
    });
  }
}

/** ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 다른 요청이 구간을 닫으면 안 된다. */
async function lockRepairExecution(tx: Tx, repairExecutionId: number): Promise<LockedRepair> {
  const rows = await tx.$queryRaw<LockedRepair[]>`
    SELECT started_at, returned_at
      FROM production.repair_execution
     WHERE repair_execution_id = ${BigInt(repairExecutionId)}
       FOR UPDATE`;
  // 계약이 이 오퍼레이션에만 404 를 선언했다 — 없는 id 는 400 이 아니다(§6-2 ⑷).
  if (rows.length === 0) throw new NotFoundException('없는 수리 건입니다.');
  return rows[0];
}
