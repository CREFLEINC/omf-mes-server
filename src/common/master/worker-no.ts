import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../errors';

/**
 * `X-Worker-No` 귀속 사번 판정 — **저장소에 열다섯 벌로 흩어져 있던 것을 셋으로 모았다**(부채 #337).
 *
 * 계약은 여섯 도메인에서 **글자 하나까지 같은** 파라미터를 쓴다(`components.parameters.WorkerNo`):
 * 「귀속용 사번 … 값은 작업자 사번(**전역 유일**)」 · `x-internal-note` 「원천 컬럼은
 * `mdm.worker.worker_no`」. ⛔ **인증이 아니다** — 비밀번호·잠금·만료를 붙이지 않는다(F-2).
 *
 * ⛔ **계약 검증 가드가 이 헤더를 보지 않는다** — `contract-validator.ts:96` 이 `$ref` 파라미터를
 * `in` 만 보고 지나가서, 필수 판정이 서비스 몫으로 남는다. 그래서 사본이 자란 것이다.
 *
 * ⭐ **갈래가 셋이고, 그 셋은 «의도»다** — 아래 세 함수의 주석이 각각의 근거다.
 * ⛔ 어느 호출부가 어느 갈래인지는 **`worker-no.spec.ts` 의 표가 정본**이고, 그 spec 이
 * 표를 소스와 대조한다 — 갈래를 바꾸면 표도 고쳐야 통과한다(README §6-4 — 공용 것을
 * 늘리면 그것을 지키는 불변식 표도 같이 늘린다).
 *
 * ⛔ **네 번째 사본을 만들지 마라.** 그 spec 이 `assertWorkerNo`/`assertWorker`/`resolveWorker`
 * 꼴의 새 정의를 **이름으로** 찾아 죽인다 — 이 파일이 열다섯 벌에서 모인 이유가 그것이다.
 *
 * ⚠ **아직 안 모은 셋**(#337 §12-1) — ⓐ `document-issue-write.service.ts` 의 `resolveWorker` 는
 * `WorkerNoOptional` 자리라 **부재를 `null` 로 돌려준다**(위 셋과 계약이 다르다) ⓑ
 * `serial-number-write-context.ts`·`document-issue-report-context.ts` 의 `requiredWorkerNo` 는
 * **헤더 파싱 층**이라 서비스 판정과 층이 다르다 ⓒ `breakdown-create.service.ts` 는 조회를
 * `Promise.all` 에 엮어 두 마스터를 함께 읽는다.
 */

/**
 * **형식만 본다** — 헤더가 왔는지.
 *
 * ⛔ `mdm.worker` 를 조회하지 않는다. 이 갈래의 오퍼레이션들은 사번을 **읽고 버린다**(담을 칸이
 * 없다 — `assigned_worker_id` 는 «배정» 축이지 «행위자» 축이 아니다). 저장하지 않는 값에
 * DB 왕복을 늘리지 않는다.
 */
export function assertWorkerNoPresent(workerNo: string | undefined): void {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
}

/**
 * **형식 + `mdm.worker` 실재**를 본다.
 *
 * 사번을 저장하거나(현품표·작업세션) 화면이 그 사번으로 사람을 되찾는 자리다 — 없는 사번이
 * 들어가면 그 행의 「누가」가 영원히 비고, 원장은 `block_ledger_header_mutation` 때문에 정정도
 * 못 한다. 그래서 여기서 가른다.
 */
export async function assertWorkerNoExists(
  prisma: Pick<Prisma.TransactionClient, 'worker'>,
  workerNo: string | undefined,
): Promise<void> {
  assertWorkerNoPresent(workerNo);
  if ((await prisma.worker.count({ where: { worker_no: workerNo } })) === 0) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
}

/**
 * **사번 → `worker_id`** — 실재를 보고 FK 로 저장할 값을 돌려준다.
 *
 * ⛔ 세션 계정(`app_user_id`)에서 도출하지 «않는다» — 계약이 헤더를 required 로 못박았고
 * `app.app_user` 와 `mdm.worker` 는 다른 축이다. ⛔ 재직 여부는 안 본다(계약이 안 적은
 * 마스터 운영 축이다 — 퇴사자의 과거 실적이 저장 불가가 되면 안 된다).
 */
export async function resolveWorkerId(
  prisma: Pick<Prisma.TransactionClient, 'worker'>,
  workerNo: string | undefined,
): Promise<bigint> {
  assertWorkerNoPresent(workerNo);
  const worker = await prisma.worker.findUnique({
    where: { worker_no: workerNo },
    select: { worker_id: true },
  });
  if (worker === null) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
  return worker.worker_id;
}
