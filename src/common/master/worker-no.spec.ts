import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ContractException, ErrorItem } from '../errors';
import { assertWorkerNoExists, assertWorkerNoPresent, resolveWorkerId } from './worker-no';

/**
 * ⭐ `X-Worker-No` 판정의 **불변식 표**다. 셋을 잠근다.
 *
 * ⑴ **사본이 다시 자라지 않는다.** 이 판정은 **열여덟 벌**로 번졌었다 — `assertWorkerNo` 열하나 ·
 *    `resolveWorker` 넷 · `assertWorker`/`assertDowntimeWorker` 둘 · 인라인 하나. 번진 이유는
 *    「계약 검증 가드가 헤더를 안 본다」(`contract-validator.ts:96`)라 판정이 서비스마다 생겼고,
 *    **아무것도 그 사실을 재지 않았기** 때문이다. 사본은 갈렸다 — 같은 물류 도메인 안에서 적치는
 *    「없는 사번」을 400 으로 막고 피킹은 「⛔ 조회하지 않는다」라 적어 통과시켰다.
 *
 * ⑵ **어느 호출부가 어느 갈래인지가 «표»로 선다.** 갈래 셋은 의도지만, 그 의도가 열여덟 자리에
 *    흩어져 있으면 다음 사람이 아무 쪽이나 베낀다.
 *
 * ⑶ **아직 안 모은 자리를 «수»로 붙잡는다** — 파싱 층 일곱 · `mdm.worker` 직접 읽기 열.
 *    늘면 빨개진다.
 *
 * ⛔ **이 spec 이 빨개졌을 때 표를 코드에 맞춰 고치는 것은 «답»이 아니다.** 갈래를 바꿨다면
 *    그게 맞는지 먼저 판단해라 — 「실재까지 본다」를 「형식만」으로 낮추면 없는 사번이 저장된다.
 *
 * 선례 — `family-conflict-code.spec.ts`(계약 × 컨트롤러 대조) · `contract-coverage.spec.ts`.
 */

const SRC = join(__dirname, '../..');
const CONTRACTS = join(SRC, '../contracts');
const SHARED = 'common/master/worker-no.ts';

/** ⭐ **형식만 본다** — 사번을 읽고 버리는 자리(담을 칸이 0개다). */
const PRESENCE_ONLY = [
  'logistics/picking/picking-pick.service.ts',
  'logistics/shipment-allocation/allocation-packing.service.ts',
  'logistics/shipment-request/shipment-pick.service.ts',
  'logistics/shopfloor-receipt/shopfloor-receipt.service.ts',
  'production/material-return/material-return.service.ts',
  'trace/lot/lot-complete.service.ts',
  'trace/lot/lot-iqc-skip.service.ts',
];

/** ⭐ **실재까지 본다** — 사번 «문자열»을 저장하거나, 저장 전 마스터에 있어야 하는 자리. */
const EXISTENCE_CHECKED = [
  'inventory/handling-unit/handling-unit-content.service.ts',
  'inventory/handling-unit/handling-unit-pack.service.ts',
  'inventory/handling-unit/handling-unit.service.ts',
  'logistics/putaway/putaway-complete.service.ts',
  'logistics/recycle-entry/recycle-entry.service.ts',
  'logistics/stock-transfer/stock-transfer.service.ts',
  'logistics/stock-transfer/transfer-arrive.service.ts',
  'maintenance/downtime/downtime-close.service.ts',
  'maintenance/downtime/downtime-create.service.ts',
  'production/operation-handover/operation-handover.service.ts',
  'production/precheck-decision/precheck-decision.service.ts',
  'production/repair-execution/repair-execution-return.service.ts',
  'production/repair-execution/repair-execution.service.ts',
  'production/work-session/work-session-end.service.ts',
  'production/work-session/work-session-event.service.ts',
  'production/work-session/work-session.service.ts',
  'trace/serial-number/serial-number-create.service.ts',
];

/** ⭐ **`worker_id` 를 FK 로 저장한다** — 마스터 행을 실제로 꺼내 쓰는 자리. */
const ID_RESOLVED = [
  'app/document-issue/document-issue-report.service.ts',
  'maintenance/tool-usage/tool-usage-create.service.ts',
  'production/material-consumption/material-consumption.service.ts',
  'production/production-result/production-result.service.ts',
];

/**
 * ⛔ **여기 셋만 이 판정을 «자기 손으로 이름 붙여» 해도 된다.** `requiredWorkerNo` 둘은 헤더 파싱
 * 층이고, `document-issue-write.resolveWorker` 는 `WorkerNoOptional` 자리라 **부재가 400 이
 * 아니라 `null`** 이다(계약이 다르다).
 */
const OWN_JUDGMENT_ALLOWED = [
  'app/document-issue/document-issue-report-context.ts',
  'app/document-issue/document-issue-write.service.ts',
  'trace/serial-number/serial-number-write-context.ts',
];

/**
 * ⚠ **헤더 파싱 층 — 「사번 50자 초과」를 재는 자리 일곱.** 서비스 층이 아니라 컨텍스트 층이라
 * 이번에 안 모았다(#337 §12-1).
 *
 * ⛔ **그런데 이미 갈렸다** — 여섯은 `RANGE`, `breakdown-write-context.ts` **하나만 `INVALID`** 다.
 * 어느 쪽이 옳은지는 계약에 없다(`WorkerNo` 는 `maxLength: 50` 만 적는다) ⇒ **설계 판정 대기**이고
 * `test/maintenance-breakdown.e2e-spec.ts:567` 이 지금 그 이탈을 «굳혀» 놓았다. 통보로 낸다.
 * ⛔ 이 표를 「고쳐서 초록으로」 만들지 마라 — 갈림 자체를 세는 것이 이 단언의 일이다.
 */
const HEADER_LENGTH_JUDGES: Record<string, 'RANGE' | 'INVALID'> = {
  'app/document-issue/document-issue-report-context.ts': 'RANGE',
  'app/document-issue/document-issue-write-context.ts': 'RANGE',
  'maintenance/breakdown/breakdown-write-context.ts': 'INVALID',
  'maintenance/downtime/downtime-write-context.ts': 'RANGE',
  'maintenance/inspection/inspection-write-context.ts': 'RANGE',
  'maintenance/tool-usage/tool-usage-write-context.ts': 'RANGE',
  'trace/serial-number/serial-number-write-context.ts': 'RANGE',
};

/**
 * ⚠ **`mdm.worker` 를 직접 읽는 자리 전건.** 위 표들은 «공용 함수를 부르는» 자리만 잡는다 —
 * 조회를 본문에 인라인하면 그 그물을 지나간다.
 *
 * 넷은 **사번 판정이 아니다**: `mdm/organization/*` 둘(마스터 CRUD·참조 수) ·
 * `work-session-worker.service.ts` 와 `work-session.service.ts`(둘 다 본문 `workerIds` 를 세는
 * «명단» 축이지 헤더 축이 아니다 — 후자는 헤더 축으로 `assertWorkerNoExists` 도 따로 부른다).
 *
 * 나머지 다섯은 **안 모은 것**이고 사유가 자리마다 다르다:
 * `document-issue-write`·`inventory-count-update`(`WorkerNoOptional` — 부재가 `null` 이다) ·
 * `breakdown-create`(다른 마스터와 한 `Promise.all`) ·
 * `inspection-write`(오류를 `errors[]` 에 **누적**해 한 봉투로 던진다 — 즉시 던지는 공용 함수로
 * 바꾸면 다중 오류 봉투가 깨진다) ·
 * `inspection-result-write`(`WorkerNoOptional` + **계정 폴백**까지 있어 갈래가 셋과 다르다).
 */
const WORKER_TABLE_READERS = [
  'app/document-issue/document-issue-write.service.ts',
  SHARED,
  'inventory/count/inventory-count-update.service.ts',
  'maintenance/breakdown/breakdown-create.service.ts',
  'maintenance/inspection/inspection-write.service.ts',
  'mdm/organization/department.service.ts',
  'mdm/organization/worker.service.ts',
  'production/work-session/work-session-worker.service.ts',
  'production/work-session/work-session.service.ts',
  'quality/inspection/inspection-result-write.service.ts',
];

interface Source {
  path: string;
  text: string;
}

let cache: Source[] | undefined;
function sources(): Source[] {
  cache ??= readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => name.split(/[\\/]/).join('/'))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(SRC, path), 'utf8') }));
  return cache;
}

/** 주석을 지운다 — 꼬리 주석 속 호출이 가짜 호출부가 되면 거짓 경보다(리뷰 #575 n-2). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * ⭐ **이름이 아니라 «import 지정자»로 찾는다.** `import { assertWorkerNoExists as verifyWorker }`
 * 한 줄이면 이름 검색은 통째로 빗나간다 — 리뷰 #575 가 그 변이로 이 표를 뚫었다(M-D ⓐ).
 * 그래서 `common/master` 에서 온 지정자를 «별칭까지» 풀어 그 로컬 이름의 호출을 센다.
 */
function callers(exported: string): string[] {
  const found: string[] = [];
  for (const { path, text } of sources()) {
    if (path === SHARED) continue;
    const body = stripComments(text);
    const locals = [...body.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*common\/master['"]/g)]
      .flatMap((match) => match[1].split(','))
      .map((piece) => piece.trim().split(/\s+as\s+/))
      .filter(([original]) => original === exported)
      .map(([original, alias]) => alias ?? original);

    if (locals.some((local) => new RegExp(`\\b${local}\\s*\\(`).test(body.replace(/import\s*\{[^}]*\}[^\n]*/g, ' '))))
      found.push(path);
  }
  return found;
}

describe('X-Worker-No 판정 — 한 벌로 모은 자리', () => {
  it('⛔ 사본이 없다 — 이 판정에 이름을 붙인 «정의»는 `worker-no.ts` 밖에 셋뿐이다', () => {
    // ⭐ `function`·클래스 메서드·**화살표 상수** 셋을 다 본다 — 화살표 꼴이 빠져 있었다(리뷰 #575 M-D ⓑ).
    // ⛔ «선언 키워드»를 요구한다. 안 그러면 `await assertWorkerNoExists(...)` 호출부까지 정의로 센다.
    const name = '(?:assertWorkerNo|assertWorker|resolveWorker|requiredWorkerNo)[A-Za-z]*';
    const definition = new RegExp(
      [
        `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, // 함수 선언
        `(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`, //            화살표 상수
        `(?:private|public|protected|async)\\s+(?:async\\s+)?${name}\\s*\\(`, // 클래스 메서드
      ].join('|'),
    );
    const defined = sources()
      .filter(({ path }) => path !== SHARED)
      .filter(({ text }) => definition.test(stripComments(text)))
      .map(({ path }) => path);

    // ⛔ 새 사본을 만들면 여기가 «파일 이름째» 빨개진다. 목록에 더하지 말고 `worker-no.ts` 를 불러라.
    expect(defined).toEqual(OWN_JUDGMENT_ALLOWED);
  });

  it('⭐ 세 갈래의 호출부가 표와 같다 — 갈래를 조용히 바꾸면 빨개진다', () => {
    expect(callers('assertWorkerNoPresent')).toEqual(PRESENCE_ONLY);
    expect(callers('assertWorkerNoExists')).toEqual(EXISTENCE_CHECKED);
    expect(callers('resolveWorkerId')).toEqual(ID_RESOLVED);
  });

  it('⛔ 한 파일이 두 갈래를 함께 쓰지 않는다 — 같은 헤더가 한 화면에서 갈린다', () => {
    const all = [...PRESENCE_ONLY, ...EXISTENCE_CHECKED, ...ID_RESOLVED];

    expect(all).toHaveLength(new Set(all).size);
  });

  it('⚠ `mdm.worker` 를 직접 읽는 자리가 열이다 — 늘면 판정이 하나 더 생긴 것이다', () => {
    // ⭐ `count|findUnique|findFirst|findMany` 넷만 보면 `findUniqueOrThrow`·`aggregate` 가
    //    지나간다(리뷰 #575 M-C ⑷ 변이 X7). 메서드 이름을 안 가린다.
    const readers = sources()
      .filter(({ text }) => /\.worker\.[A-Za-z]+\(/.test(stripComments(text)))
      .map(({ path }) => path);

    expect(readers).toEqual(WORKER_TABLE_READERS);
  });

  it('⛔ 헤더 길이 판정이 일곱 자리에 남아 있고, 그중 하나가 «갈려» 있다 — 설계 판정 대기', () => {
    const judges: Record<string, string> = {};
    for (const { path, text } of sources()) {
      const body = stripComments(text);
      const at = body.search(/\.length\s*>\s*50/);
      if (at < 0 || !body.toLowerCase().includes('x-worker-no')) continue;
      judges[path] = /ERROR_CODE\.(\w+)/.exec(body.slice(at, at + 400))?.[1] ?? '?';
    }

    expect(judges).toEqual(HEADER_LENGTH_JUDGES);
    // ⛔ 여섯 대 하나. 이 «비대칭»이 통보의 내용이다 — 초록으로 만들려고 코드를 고치지 마라.
    expect(Object.values(judges).filter((code) => code === 'INVALID')).toHaveLength(1);
  });

  it('⭐ 계약이 이 헤더를 «필수»로 건 오퍼레이션은 37 이다 — 늘면 갈래를 정해야 한다', () => {
    let required = 0;
    for (const file of readdirSync(CONTRACTS).filter((name) => name.endsWith('.json'))) {
      const document = JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as {
        paths: Record<string, Record<string, { parameters?: { $ref?: string }[] }>>;
      };
      for (const item of Object.values(document.paths)) {
        for (const operation of Object.values(item)) {
          if ((operation.parameters ?? []).some((p) => p.$ref?.endsWith('/WorkerNo'))) required += 1;
        }
      }
    }

    // ⛔ 이 숫자가 늘었는데 위 세 표가 그대로면, 새 오퍼레이션이 판정을 «안 하고» 있다는 뜻이다.
    expect(required).toBe(37);
  });
});

describe('세 함수의 행동', () => {
  const worker = (row: { worker_id: bigint } | null) =>
    ({ worker: { findUnique: () => Promise.resolve(row) } }) as unknown as Parameters<
      typeof resolveWorkerId
    >[0];
  const found = worker({ worker_id: 7n });
  const missing = worker(null);

  /** ⛔ `ContractException.message` 는 언제나 'Contract Exception' 이다 — 봉투 «항목»을 본다. */
  const thrownBy = async (run: () => unknown): Promise<ErrorItem> => {
    try {
      await run();
    } catch (error) {
      return (error as ContractException).errors[0];
    }
    throw new Error('던지지 않았다');
  };

  it.each([undefined, '', '   '])('부재·공백은 400 REQUIRED 다 (%p)', async (value) => {
    const item = await thrownBy(() => assertWorkerNoPresent(value));

    expect(item).toEqual({
      scope: 'field',
      field: 'X-Worker-No',
      code: 'REQUIRED',
      message: expect.any(String),
    });
  });

  it('값이 있으면 통과한다 — 형식(6자리 숫자)은 «강제하지 않는다»(계약 A-9 ⓑ)', () => {
    expect(() => assertWorkerNoPresent('abc-1')).not.toThrow();
  });

  it('⭐ 실재 갈래는 부재를 REQUIRED 로, 없는 사번을 INVALID 로 가른다 — 두 코드가 다르다', async () => {
    expect((await thrownBy(() => assertWorkerNoExists(found, undefined))).code).toBe('REQUIRED');
    expect((await thrownBy(() => assertWorkerNoExists(missing, '100027'))).code).toBe('INVALID');
    // ⭐ 좁혀진 사번을 그대로 돌려준다 — 헤더 문자열을 저장하는 자리가 캐스트 없이 쓴다.
    await expect(assertWorkerNoExists(found, '100027')).resolves.toBe('100027');
  });

  it('⭐ `worker_id` 갈래도 같은 두 갈래를 가르고, 있으면 id 를 돌려준다', async () => {
    expect((await thrownBy(() => resolveWorkerId(found, undefined))).code).toBe('REQUIRED');
    expect((await thrownBy(() => resolveWorkerId(missing, '100027'))).code).toBe('INVALID');
    await expect(resolveWorkerId(found, '100027')).resolves.toBe(7n);
  });
});
