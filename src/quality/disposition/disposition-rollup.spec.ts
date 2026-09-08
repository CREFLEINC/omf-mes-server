import { Prisma } from '@prisma/client';

import { dispositionFollowUp, dispositionProgressCode, remainingSummary } from './disposition-rollup';

/**
 * `disposition-rollup.ts` 의 갈래 단위 시험(계획 §8-5 · 16건). 세 조회가 이 파일 하나를 부르므로
 * 여기서 갈리면 목록의 「판정 진행」과 상세의 「남은 수량」과 진입 목록이 서로 다른 답을 낸다.
 *
 * ⭐ 픽스처가 «한계와 같은 값»과 «스케일 한 자리 넘는 값»을 함께 든다 — 물리가 `numeric(20,6)`
 *    이라 비교 연산자 하나(`>` ↔ `>=`)와 부동소수 누적이 둘 다 이 자리에서만 잡힌다.
 */
const dec = (value: string) => new Prisma.Decimal(value);
const posted = (qty: string) => ({ statusCode: 'POSTED', issueQty: dec(qty) });

const UOM = 1001;

describe('remainingSummary — 잔량 산식(계약 DispositionRemainingSummary)', () => {
  it('결정이 0건이면 남은 수량이 대상 전량이다', () => {
    expect(remainingSummary(dec('320'), dec('0'), UOM)).toEqual({
      affectedQtyTotal: 320,
      decidedQtyTotal: 0,
      remainingQty: 320,
      uomId: UOM,
    });
  });

  it('⭐ 남은 수량 = 대상 − 결정이고 «부동소수로 세지 않는다»(320.3 − 200.2 = 120.1)', () => {
    // ⛔ 부동소수면 120.10000000000002 가 나오고 그 값이 그대로 화면의 「남은 수량」이 된다.
    expect(remainingSummary(dec('320.3'), dec('200.2'), UOM).remainingQty).toBe(120.1);
    // 뺄셈의 «방향»도 잠근다 — 뒤집히면 부호가 바뀐다.
    expect(remainingSummary(dec('200.2'), dec('320.3'), UOM).remainingQty).toBe(-120.1);
  });

  it('전량 결정이면 남은 수량이 «정확히» 0 이다(한계와 같은 값 · R-19)', () => {
    expect(remainingSummary(dec('120.500001'), dec('120.500001'), UOM).remainingQty).toBe(0);
  });

  it('⭐ 소수 6자리를 잃지 않고 uomId 를 그대로 싣는다(numeric(20,6))', () => {
    expect(remainingSummary(dec('120.500001'), dec('0.000001'), 2002)).toEqual({
      affectedQtyTotal: 120.500001,
      decidedQtyTotal: 0.000001,
      remainingQty: 120.5,
      uomId: 2002,
    });
  });
});

describe('dispositionProgressCode — 판정 진행(계약 Nonconformance.dispositionProgressCode)', () => {
  it('⛔ 결정 0건은 NOT_STARTED 다 — 잔량으로 대신 보면 「미판정」이 「일부 판정」으로 접힌다', () => {
    expect(dispositionProgressCode(0, dec('320'), dec('0'))).toBe('NOT_STARTED');
  });

  it('결정이 있고 남은 수량 > 0 이면 PARTIAL 이다(잔량이 스케일 한 자리여도)', () => {
    expect(dispositionProgressCode(1, dec('320'), dec('200'))).toBe('PARTIAL');
    expect(dispositionProgressCode(2, dec('120.500001'), dec('120.5'))).toBe('PARTIAL');
  });

  it('⭐ 남은 수량이 «정확히» 0 이면 COMPLETED 다 — `>` 를 `>=` 로 바꾸면 여기서 깨진다(R-19)', () => {
    expect(dispositionProgressCode(2, dec('120.500001'), dec('120.500001'))).toBe('COMPLETED');
    // 잔량이 음수로 새더라도(409 가 막지만) 「완료」다 — PARTIAL 에 갇히지 않는다.
    expect(dispositionProgressCode(2, dec('120'), dec('130'))).toBe('COMPLETED');
  });
});

describe('dispositionFollowUp — 후속 롤업(통보 089 §4)', () => {
  it('⭐ SCRAP 은 폐기 출고를 합쳐 롤업한다 — 0건 NOT_STARTED · 일부 PARTIAL · 채우면 COMPLETED', () => {
    expect(dispositionFollowUp('SCRAP', dec('30'), [])).toMatchObject({
      followUpQty: 0,
      followUpStatusCode: 'NOT_STARTED',
    });
    // ⛔ 부동소수면 0.1 + 0.2 가 0.30000000000000004 다.
    expect(dispositionFollowUp('SCRAP', dec('30'), [posted('0.1'), posted('0.2')])).toMatchObject({
      followUpQty: 0.3,
      followUpStatusCode: 'PARTIAL',
    });
    // ⭐ 한계와 «같은» 값 — `>=` 를 `>` 로 바꾸면 여기서 깨진다(R-19).
    expect(
      dispositionFollowUp('SCRAP', dec('30.000001'), [posted('20.000001'), posted('10')]).followUpStatusCode,
    ).toBe('COMPLETED');
    // 한계보다 스케일 한 자리 «아래»는 아직 PARTIAL 이다.
    expect(dispositionFollowUp('SCRAP', dec('30.000001'), [posted('30')]).followUpStatusCode).toBe('PARTIAL');
    // 초과 출고가 서도 PARTIAL 에 갇히지 않는다.
    expect(dispositionFollowUp('SCRAP', dec('30'), [posted('31')]).followUpStatusCode).toBe('COMPLETED');
  });

  it('⛔ REWORK 는 후속 원천이 0 이라 전기된 출고를 줘도 0/NOT_STARTED 고정이다', () => {
    expect(dispositionFollowUp('REWORK', dec('160'), [posted('160')])).toMatchObject({
      followUpQty: 0,
      followUpStatusCode: 'NOT_STARTED',
    });
  });

  it('⛔ NORMAL 도 마찬가지다 — 재등록 전표(stock_reinstatement)가 물리에 아직 없다', () => {
    expect(dispositionFollowUp('NORMAL', dec('160'), [posted('160')])).toMatchObject({
      followUpQty: 0,
      followUpStatusCode: 'NOT_STARTED',
    });
  });

  it('⭐⭐ POSTED 아닌 폐기 출고는 세지 않는다 — 취소·미전기는 「후속 처리된 수량」이 아니다', () => {
    // 결정 — 통보 089
    const mixed = [
      { statusCode: 'REGISTERED', issueQty: dec('10') },
      { statusCode: 'CANCEL_REQUESTED', issueQty: dec('10') },
      { statusCode: 'CANCELLED', issueQty: dec('10') },
      posted('5'),
    ];
    expect(dispositionFollowUp('SCRAP', dec('30'), mixed)).toMatchObject({
      followUpQty: 5,
      followUpStatusCode: 'PARTIAL',
    });
    // 필터를 빼면 35 가 되어 COMPLETED 로 넘어간다(I-20 ①c 와 같은 자리).
    expect(dispositionFollowUp('SCRAP', dec('30'), mixed.slice(0, 3)).followUpStatusCode).toBe('NOT_STARTED');
  });
});

describe('followUpPending — 「후속 원천이 있는 유형만」(통보 089 §4 #3)', () => {
  it('SCRAP 은 후속이 남았으면 참이고 다 나가면 거짓이다', () => {
    // 결정 — 통보 089
    expect(dispositionFollowUp('SCRAP', dec('30'), []).followUpPending).toBe(true);
    expect(dispositionFollowUp('SCRAP', dec('30'), [posted('10')]).followUpPending).toBe(true);
    expect(dispositionFollowUp('SCRAP', dec('30'), [posted('30')]).followUpPending).toBe(false);
  });

  it('⛔ REWORK 는 «전기된 출고가 붙어 있어도» 거짓이다 — 참이면 같은 건을 두 번 처리한다', () => {
    // ⭐⭐ 「안 걸리는 행」이다 — 픽스처를 비우면 축을 「유형」이 아니라 「전기된 출고가 있으면」
    // 이라는 «데이터»로 구현해도 이 시험이 초록이다(리뷰 M-1 · 변이 X14). // 결정 — 통보 089
    expect(dispositionFollowUp('REWORK', dec('160'), [posted('160')]).followUpPending).toBe(false);
    expect(dispositionFollowUp('REWORK', dec('160'), []).followUpPending).toBe(false);
  });

  it('⛔ NORMAL 도 마찬가지다 — 그 화면의 진입 축은 reinstatable 이다', () => {
    expect(dispositionFollowUp('NORMAL', dec('160'), [posted('160')]).followUpPending).toBe(false);
    expect(dispositionFollowUp('NORMAL', dec('160'), []).followUpPending).toBe(false);
  });
});

describe('reinstatable — 재고로 되돌릴 수 있는 결정(통보 089 §4 #4)', () => {
  it('NORMAL 만 참이다 — 후속 진행과 무관하다', () => {
    // 결정 — 통보 089 (계약의 「재작업이고 끝난 것」 절은 원천이 0이라 닿지 않는다 · 089 §4 #4)
    expect(dispositionFollowUp('NORMAL', dec('160'), []).reinstatable).toBe(true);
    expect(dispositionFollowUp('NORMAL', dec('160'), [posted('160')]).reinstatable).toBe(true);
  });

  it('⛔ SCRAP 은 계약이 명시로 뺐고 REWORK 는 「끝난 재작업」을 오늘 셀 수 없어 둘 다 거짓이다', () => {
    expect(dispositionFollowUp('SCRAP', dec('30'), [posted('30')]).reinstatable).toBe(false);
    expect(dispositionFollowUp('REWORK', dec('160'), [posted('160')]).reinstatable).toBe(false);
  });
});
