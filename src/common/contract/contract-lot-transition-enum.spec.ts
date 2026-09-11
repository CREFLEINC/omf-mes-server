/**
 * v0.1.2 서버 계약의 LOT 전이 enum 정합을 검증한다.
 *
 * 응답은 실제 전이 C17~C20을 포함한 13종을 담고, 질의 enum은 아직 기존 9종만 받는다.
 * 이 차이는 계약의 `x-omf-known-differences`(통보 218)에 명시된 기준선이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TRANSITIONS } from '../../core/document-state/transitions';

const CONTRACT = join(__dirname, '../../../contracts/logistics-01자재창고.json');
/** ⚠ 품질 축의 칸 이름은 `quality_status_code` 가 아니라 `status_code` 다(실측 · 생명주기 축이 따로 있다). */
const LOT_QUALITY_STATUS = 'trace.lot.status_code';

/** v0.1.2 응답 enum에는 들어왔지만 질의 enum에는 아직 없는 값(계약 x-omf-known-differences). */
const KNOWN_QUERY_GAP = ['C17', 'C18', 'C19', 'C20'];

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

  it('⭐ v0.1.2 응답 enum은 서버가 쓰는 LOT 전이 코드 전건을 담는다', () => {
    const outside = usedCodes().filter((code) => !responseEnum().includes(code));

    expect(outside).toEqual([]);
  });

  it('⚠ v0.1.2에 명시된 질의 enum 간극은 C17~C20 넷으로 고정된다', () => {
    const queryGap = responseEnum().filter((code) => !queryEnum().includes(code));

    expect(queryGap).toEqual(KNOWN_QUERY_GAP);
  });

  it('⭐ 응답 enum은 실제 사용 코드보다 넓을 수 있다', () => {
    const used = usedCodes();

    expect(used.filter((code) => !responseEnum().includes(code))).toEqual([]);
    // 계약 9값 중 우리가 «안 쓰는» 것도 있다 — 그것은 정상이다(다른 슬라이스가 열 자리).
    expect(used.length).toBeLessThan(responseEnum().length);
  });
});
