import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ContractException, ErrorItem } from '../errors';
import { assertWorkerNoExists, assertWorkerNoPresent, resolveWorkerId } from './worker-no';

/**
 * ⭐ `X-Worker-No` 판정의 **불변식 표**다. 두 가지를 잠근다.
 *
 * ⑴ **사본이 다시 자라지 않는다.** 이 판정은 저장소에 **열다섯 벌**로 번졌었다 — 같은 이름
 *    (`assertWorkerNo`) 열하나, `resolveWorker` 셋, `assertWorker` 하나. 번진 이유는 「계약 검증
 *    가드가 헤더를 안 본다」(`contract-validator.ts:96`)라 판정이 서비스마다 생겼고, **아무것도
 *    그 사실을 재지 않았기** 때문이다. 사본은 갈렸다 — 같은 물류 도메인 안에서 적치는 「없는
 *    사번」을 400 으로 막고 피킹은 「⛔ 조회하지 않는다」라 적어 통과시켰다.
 *
 * ⑵ **어느 호출부가 어느 갈래인지가 «표»로 선다.** 갈래 셋은 의도지만, 그 의도가 코드 열다섯
 *    자리에 흩어져 있으면 다음 사람이 아무 쪽이나 베낀다.
 *
 * ⛔ **이 spec 이 빨개졌을 때 표를 코드에 맞춰 고치는 것은 «답»이 아니다.** 갈래를 바꿨다면
 *    그게 맞는지 먼저 판단해라 — 「실재까지 본다」를 「형식만」으로 낮추면 없는 사번이 저장된다.
 *
 * 선례 — `family-conflict-code.spec.ts`(계약 × 컨트롤러 대조) · `contract-coverage.spec.ts`.
 */

const SRC = join(__dirname, '../..');
const CONTRACTS = join(SRC, '../contracts');

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
  'logistics/stock-transfer/stock-transfer.service.ts',
  'logistics/stock-transfer/transfer-arrive.service.ts',
  'production/operation-handover/operation-handover.service.ts',
  'production/precheck-decision/precheck-decision.service.ts',
  'production/repair-execution/repair-execution-return.service.ts',
  'production/repair-execution/repair-execution.service.ts',
  'production/work-session/work-session-end.service.ts',
  'production/work-session/work-session-event.service.ts',
  'production/work-session/work-session.service.ts',
  'trace/serial-number/serial-number-create.service.ts',
];

/** ⭐ **`worker_id` 를 FK 로 저장한다** — 여기서만 마스터 행을 실제로 꺼낸다. */
const ID_RESOLVED = [
  'production/material-consumption/material-consumption.service.ts',
  'production/production-result/production-result.service.ts',
];

/**
 * ⛔ **여기 셋만 이 판정을 «자기 손으로» 해도 된다.** 나머지는 전부 `worker-no.ts` 를 부른다.
 * 셋의 사유는 `worker-no.ts` 머리 주석 ⓐⓑ 에 있다 — 층이 다르거나(헤더 파싱) 계약이
 * 다르다(`WorkerNoOptional` 은 부재가 `null` 이고 400 이 아니다).
 */
const OWN_JUDGMENT_ALLOWED = [
  'app/document-issue/document-issue-report-context.ts',
  'app/document-issue/document-issue-write.service.ts',
  'trace/serial-number/serial-number-write-context.ts',
];

/**
 * ⚠ **`mdm.worker` 를 직접 읽는 자리 전건.** 위 셋은 «이름 붙은 도우미»만 잡는다 — 조회를
 * 도우미 없이 본문에 인라인하면 그 그물을 지나간다(`breakdown-create.service.ts` 가 그렇다).
 * ⛔ **여기 목록이 늘면 사번 판정이 또 하나 생긴 것이다.** 아래 셋만 사번 판정이 «아니다»:
 * `mdm/organization/*`(마스터 CRUD·참조 수) · `work-session-worker.service.ts`(세션의 작업자
 * 명단 축이지 헤더 축이 아니다). ⚠ 나머지 여섯은 `WorkerNoOptional` 이거나 조회를 다른 마스터와
 * `Promise.all` 로 묶은 자리다 — 갈래가 셋과 달라 이번에 안 모았다(#337 §12-1).
 */
const WORKER_TABLE_READERS = [
  'app/document-issue/document-issue-report.service.ts',
  'app/document-issue/document-issue-write.service.ts',
  'common/master/worker-no.ts',
  'inventory/count/inventory-count-update.service.ts',
  'maintenance/breakdown/breakdown-create.service.ts',
  'maintenance/downtime/downtime-rules.ts',
  'maintenance/inspection/inspection-write.service.ts',
  'maintenance/tool-usage/tool-usage-create.service.ts',
  'mdm/organization/department.service.ts',
  'mdm/organization/worker.service.ts',
  'production/work-session/work-session-worker.service.ts',
  'production/work-session/work-session.service.ts',
  'quality/inspection/inspection-result-write.service.ts',
];

function sources(): { path: string; text: string }[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => name.split(/[\\/]/).join('/'))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(SRC, path), 'utf8') }));
}

/** 도우미 이름을 «부르는» 파일. import 줄은 세지 않는다 — 그것까지 세면 전건이 걸린다. */
function callers(name: string): string[] {
  const call = new RegExp(`(?<!\\b(?:import|export)\\b[^\\n]*)\\b${name}\\(`);
  return sources()
    .filter(({ path }) => path !== 'common/master/worker-no.ts')
    .filter(({ text }) =>
      text
        .split('\n')
        .some((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && call.test(line)),
    )
    .map(({ path }) => path);
}

describe('X-Worker-No 판정 — 한 벌로 모은 자리', () => {
  it('⛔ 사본이 없다 — 이 이름들의 «정의»는 `worker-no.ts` 밖에 셋뿐이다', () => {
    const defined = sources()
      .filter(({ path }) => path !== 'common/master/worker-no.ts')
      .filter(({ text }) =>
        /(?:^|\n)\s*(?:export\s+)?(?:private\s+)?(?:async\s+)?(?:function\s+)?(?:assertWorkerNo|assertWorker|resolveWorker|requiredWorkerNo)\s*\(/.test(
          text,
        ),
      )
      .map(({ path }) => path);

    // ⛔ 새 사본을 만들면 여기가 «파일 이름째» 빨개진다. 목록에 더하지 말고 `worker-no.ts` 를 불러라.
    expect(defined).toEqual(OWN_JUDGMENT_ALLOWED);
  });

  it('⚠ `mdm.worker` 를 직접 읽는 자리가 열셋이다 — 늘면 판정이 하나 더 생긴 것이다', () => {
    const readers = sources()
      .filter(({ text }) => /\.worker\.(?:count|findUnique|findFirst|findMany)\(/.test(text))
      .map(({ path }) => path);

    expect(readers).toEqual(WORKER_TABLE_READERS);
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
  const worker = (count: number, row: { worker_id: bigint } | null) =>
    ({
      worker: {
        count: () => Promise.resolve(count),
        findUnique: () => Promise.resolve(row),
      },
    }) as never;

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

    expect(item).toEqual({ scope: 'field', field: 'X-Worker-No', code: 'REQUIRED', message: expect.any(String) });
  });

  it('값이 있으면 통과한다 — 형식(6자리 숫자)은 «강제하지 않는다»(계약 A-9 ⓑ)', () => {
    expect(() => assertWorkerNoPresent('abc-1')).not.toThrow();
  });

  it('⭐ 실재 갈래는 부재를 REQUIRED 로, 없는 사번을 INVALID 로 가른다 — 두 코드가 다르다', async () => {
    expect((await thrownBy(() => assertWorkerNoExists(worker(1, null), undefined))).code).toBe('REQUIRED');
    expect((await thrownBy(() => assertWorkerNoExists(worker(0, null), '100027'))).code).toBe('INVALID');
    await expect(assertWorkerNoExists(worker(1, null), '100027')).resolves.toBeUndefined();
  });

  it('⭐ `worker_id` 갈래도 같은 두 갈래를 가르고, 있으면 id 를 돌려준다', async () => {
    expect((await thrownBy(() => resolveWorkerId(worker(0, null), undefined))).code).toBe('REQUIRED');
    expect((await thrownBy(() => resolveWorkerId(worker(0, null), '100027'))).code).toBe('INVALID');
    await expect(resolveWorkerId(worker(1, { worker_id: 7n }), '100027')).resolves.toBe(7n);
  });
});
