import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../errors';

/**
 * `X-Worker-No` 귀속 사번 판정 — **저장소에 열여덟 벌로 흩어져 있던 것을 셋으로 모았다**(부채 #337).
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
 * ⚠ **아직 안 모은 둘**(#337 §12-1 · 리뷰 #575 M-B·M-C 가 수를 바로잡았다):
 *
 * ⓐ **헤더 파싱 층 일곱** — `*-write-context.ts` 류가 「부재 + 50자 초과」를 컨텍스트 조립 때
 *   본다. 서비스 판정과 층이 달라 이번에 안 모았다. ⛔ **그런데 이미 갈렸다** — 여섯은 50자
 *   초과를 `RANGE` 로, `breakdown-write-context.ts` 하나만 `INVALID` 로 낸다. 어느 쪽이 옳은지
 *   계약에 없어(`maxLength: 50` 만 적는다) **설계 판정 대기**이고, 그 갈림 자체를
 *   `worker-no.spec.ts` 의 `HEADER_LENGTH_JUDGES` 가 센다.
 *
 * ⓑ **`mdm.worker` 를 인라인으로 읽는 다섯** — `WorkerNoOptional` 이라 부재가 400 이 아니라
 *   `null` 인 자리 셋(`document-issue-write`·`inventory-count-update`·`inspection-result-write`,
 *   마지막은 계정 폴백까지 있다) · 오류를 `errors[]` 에 **누적**해 한 봉투로 던지는 자리
 *   (`inspection-write` — 즉시 던지는 공용 함수로 바꾸면 다중 오류 봉투가 깨진다) ·
 *   다른 마스터와 한 `Promise.all` 로 묶인 자리(`breakdown-create`).
 */

/**
 * **형식만 본다** — 헤더가 왔는지.
 *
 * ⛔ `mdm.worker` 를 조회하지 않는다. 이 갈래의 오퍼레이션들은 사번을 **읽고 버린다**(담을 칸이
 * 없다 — `assigned_worker_id` 는 «배정» 축이지 «행위자» 축이 아니다). 저장하지 않는 값에
 * DB 왕복을 늘리지 않는다.
 */
export function assertWorkerNoPresent(workerNo: string | undefined): asserts workerNo is string {
  if (workerNo === undefined || workerNo.trim() === '') {
    throw one(field('X-Worker-No', ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
  }
}

/**
 * 셋이 공유하는 한 번의 조회.
 *
 * ⛔ `count` 가 아니라 `findUnique` 다 — Prisma 는 `where: { worker_no: undefined }` 를
 * 「필터 없음」으로 읽어 `count` 가 **전건을 세고 통과시킨다.** 위 부재 판정을 누가 지우면
 * 조용히 통과하는 것이 아니라 **터져야** 한다(리뷰 #575 m-1).
 */
async function findWorkerId(
  prisma: Pick<Prisma.TransactionClient, 'worker'>,
  workerNo: string,
): Promise<bigint> {
  const worker = await prisma.worker.findUnique({
    where: { worker_no: workerNo },
    select: { worker_id: true },
  });
  if (worker === null) {
    throw one(field('X-Worker-No', ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
  }
  return worker.worker_id;
}

/**
 * **형식 + `mdm.worker` 실재**를 본다.
 *
 * 사번을 저장하거나(현품표·작업세션) 화면이 그 사번으로 사람을 되찾는 자리다 — 없는 사번이
 * 들어가면 그 행의 「누가」가 영원히 비고, 원장은 `block_ledger_header_mutation` 때문에 정정도
 * 못 한다. 그래서 여기서 가른다.
 *
 * 좁혀진 사번을 **돌려준다** — 헤더 문자열을 그대로 저장하는 자리(`precheck_decision.worker_no`)가
 * `as string` 캐스트 없이 쓴다.
 */
export async function assertWorkerNoExists(
  prisma: Pick<Prisma.TransactionClient, 'worker'>,
  workerNo: string | undefined,
): Promise<string> {
  assertWorkerNoPresent(workerNo);
  await findWorkerId(prisma, workerNo);
  return workerNo;
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
  return findWorkerId(prisma, workerNo);
}
