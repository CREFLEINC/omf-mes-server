import { ERROR_CODE, field, one } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ⚠ 사번을 **읽고 버린다** — `inventory.handling_unit` 에 행위자 칸이 0개다(`created_by`
 * 는 `app.app_user` 축이고 사번은 `mdm.worker.worker_no` 축이다). 계약이 `WorkerNo` 를
 * required 로 못박았고 헤더는 계약 검증 가드가 안 본다(`contract-validation.guard.ts` —
 * `$ref` 파라미터를 `in` 만 보고 지나간다).
 *
 * `assertWorkerNo` **아홉째 사본**이다(`transfer-arrive.service.ts:259` 복제).
 * ⛔ 공용화하지 않는다 — I-11 R-11 의 「공용화는 후속 PR 로」가 아직 살아 있다
 * (`precheck-decision.service.ts:70`).
 */
export async function assertWorkerNo(
  prisma: PrismaService,
  workerNo: string | undefined,
): Promise<void> {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
  if ((await prisma.worker.count({ where: { worker_no: workerNo } })) === 0) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
}
