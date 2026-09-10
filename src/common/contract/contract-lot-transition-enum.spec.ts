/**
 * ⭐⭐ **우리가 쓰는 LOT 전이 코드 중 «계약 enum 밖»에 있는 것을 «세는» 표.**
 *
 * `LotStatusHistoryEvent.transitionCode` 는 **required + enum 9값**(C4~C10·C14·C15)이고
 * `GET /trace/lot-status-events` 의 질의 축도 **같은 9값**이다. 그런데 `transitions.ts` 는
 * 그 밖의 코드를 **넷** 쓴다 — I-21 의 `C17`·`C18`·`C19`(처분 판정 셋)와 I-23 의 `C20`(재등록).
 *
 * ⛔ **무슨 일이 나는가**
 *   - 처분·재등록이 남긴 이력 행이 `GET /trace/lot-status-events` 응답에 뜨는 순간 **ajv 가 깨진다.**
 *   - 화면이 `?transitionCode=C19` 로 거르면 우리 계약 검증 가드가 **400** 을 낸다.
 *   ⇒ 값을 만든 슬라이스가 아니라 **조회 슬라이스가 나중에 부서진다** — 인과가 안 보인다.
 *
 * ⛔ **선반영하지 «않는» 판정**(I-23 R-11 정정). I-17 은 `RECYCLE_ENTRY` 를 사본에 선반영했지만
 * 그것은 **답이 온 질의**(213)였다. 여기 넷은 **우리가 정하고 통보한** 값이고, 그중 셋은
 * **I-21 이 선반영 없이 이미 병합했다.** C20 만 넣으면 넷 중 하나만 가려져 문제가 더 안 보인다.
 * ⇒ 대신 **간극 자체를 여기서 센다.**
 *
 * ⭐ **이 표가 빨개지는 두 경우가 다 뜻이 있다**
 *   ⓐ 우리가 **다섯째 코드**를 몰래 더했다 ⇒ 통보에 실렸는지 확인하라.
 *   ⓑ 설계 변동 공지가 넷 중 일부를 **enum 에 실었다** ⇒ 축하할 일이다. `KNOWN_GAP` 에서 빼라.
 *   ⛔ 어느 쪽이든 «지워서» 넘기지 마라.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TRANSITIONS } from '../../core/document-state/transitions';

const CONTRACT = join(__dirname, '../../../contracts/logistics-01자재창고.json');
/** ⚠ 품질 축의 칸 이름은 `quality_status_code` 가 아니라 `status_code` 다(실측 · 생명주기 축이 따로 있다). */
const LOT_QUALITY_STATUS = 'trace.lot.status_code';

/** 오늘 계약 밖인 것 — 통보 089(C17~C19 · I-21) · 통보 218(C20 · I-23). */
const KNOWN_GAP = ['C17', 'C18', 'C19', 'C20'];

describe('계약 사본 — LOT 전이 코드의 enum 간극 (통보 089·218)', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
    paths: Record<
      string,
      Record<string, { parameters?: { name: string; schema?: { enum?: string[] } }[] }>
    >;
    components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
  };

  const responseEnum = (): string[] =>
    contract.components.schemas.LotStatusHistoryEvent?.properties?.transitionCode?.enum ?? [];

  const queryEnum = (): string[] =>
    contract.paths['/trace/lot-status-events']?.get?.parameters?.find(
      (parameter) => parameter.name === 'transitionCode',
    )?.schema?.enum ?? [];

  /** `transitions.ts` 가 LOT 품질 축에서 실제로 쓰는 코드 전건. */
  const usedCodes = (): string[] =>
    Object.values(TRANSITIONS[LOT_QUALITY_STATUS])
      .flatMap((transition) => (transition.transitionCode === undefined ? [] : [transition.transitionCode]))
      .sort();

  it('⛔ 계약 밖인 코드가 «정확히» 넷이다 — 늘었으면 통보에 실렸는지 확인하라', () => {
    const outside = usedCodes().filter((code) => !responseEnum().includes(code));

    expect(outside).toEqual(KNOWN_GAP);
  });

  it('⭐ 응답 축과 질의 축이 «같은 값 집합»이다 — 한쪽만 고치면 응답과 필터가 갈린다', () => {
    expect([...queryEnum()].sort()).toEqual([...responseEnum()].sort());
  });

  it('⭐ 간극 밖의 코드는 전건 계약 안이다 — 검사·보류 축이 조용히 새지 않았나', () => {
    const inside = usedCodes().filter((code) => !KNOWN_GAP.includes(code));

    expect(inside.filter((code) => !responseEnum().includes(code))).toEqual([]);
    // 계약 9값 중 우리가 «안 쓰는» 것도 있다 — 그것은 정상이다(다른 슬라이스가 열 자리).
    expect(inside.length).toBeLessThan(responseEnum().length + KNOWN_GAP.length);
  });
});
