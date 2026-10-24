import { Prisma } from '@prisma/client';

import { LotStageFacts, labelStage, lotStage, stageGroupOf } from './inbound-stage';

const IQC_HOLD = { code: 'INCOMING_INSPECTION_WAIT', name: '수입검사 대기' };
const CLAIM_HOLD = { code: 'CLAIM_RECALL', name: '클레임·리콜' };

/** 기본 = 검사 대상 LOT 이 입하되어 의뢰가 접수된 그때. */
const facts = (overrides: Partial<LotStageFacts> = {}): LotStageFacts => ({
  receiptCancelled: false,
  lotStatusCode: 'INSPECTION_PENDING',
  inspectionRequired: true,
  inspectionStatusCode: 'REQUESTED',
  openHolds: [IQC_HOLD],
  receivableQty: new Prisma.Decimal('100'),
  putawayStatusCodes: [],
  ...overrides,
});

/** 입고를 다 마친 LOT — 적치 작업 상태만 바꿔 본다. */
const received = (putawayStatusCodes: string[]): LotStageFacts =>
  facts({
    lotStatusCode: 'NORMAL',
    inspectionStatusCode: 'COMPLETED',
    openHolds: [],
    receivableQty: new Prisma.Decimal('0'),
    putawayStatusCodes,
  });

describe('lotStage — 입고 관리 허브의 LOT 단계(장부 P-110)', () => {
  it('입하 전표가 취소됐으면 CANCELLED 다 — 입고·적치가 남아 있어도 그렇다', () => {
    expect(lotStage(facts({ receiptCancelled: true }))).toEqual({
      stageCode: 'CANCELLED',
      nextActionCode: null,
      blockedReasons: [],
    });
    expect(lotStage({ ...received(['PENDING']), receiptCancelled: true }).stageCode).toBe('CANCELLED');
  });

  it('입고 전에 폐기된 LOT 은 CANCELLED 다', () => {
    expect(lotStage(facts({ lotStatusCode: 'SCRAPPED', openHolds: [] })).stageCode).toBe('CANCELLED');
  });

  it('입고·적치를 마친 뒤 폐기된 LOT 은 COMPLETED 다 — 입고 흐름은 끝났다', () => {
    expect(lotStage({ ...received(['COMPLETED']), lotStatusCode: 'SCRAPPED' }).stageCode).toBe('COMPLETED');
  });

  it('검사 대상 LOT 이 의뢰 REQUESTED 면 INSPECTION_REQUESTED 다 — 다음 할 일은 없다', () => {
    expect(lotStage(facts())).toEqual({
      stageCode: 'INSPECTION_REQUESTED',
      nextActionCode: null,
      blockedReasons: [],
    });
  });

  it('첫 임시 저장 뒤(IN_PROGRESS)면 INSPECTION_IN_PROGRESS 다', () => {
    expect(lotStage(facts({ inspectionStatusCode: 'IN_PROGRESS' })).stageCode).toBe('INSPECTION_IN_PROGRESS');
  });

  it('검사 대상인데 열린 의뢰가 없으면 INSPECTION_REQUIRED 다 — IQC 의뢰 단추는 아직 주지 않는다', () => {
    for (const inspectionStatusCode of [null, 'CANCELLED']) {
      expect(lotStage(facts({ inspectionStatusCode }))).toEqual({
        stageCode: 'INSPECTION_REQUIRED',
        nextActionCode: null,
        blockedReasons: [],
      });
    }
  });

  it('판정 보류면 INSPECTION_HELD 이고 열린 보류 사유가 이름까지 실린다', () => {
    expect(lotStage(facts({ inspectionStatusCode: 'COMPLETED' }))).toEqual({
      stageCode: 'INSPECTION_HELD',
      nextActionCode: null,
      blockedReasons: [IQC_HOLD],
    });
  });

  it('합격 뒤에도 다른 보류가 열려 있으면 INSPECTION_HELD 다 — LOT 이 검사 대기에 남는다', () => {
    const stage = lotStage(facts({ inspectionStatusCode: 'COMPLETED', openHolds: [CLAIM_HOLD] }));
    expect(stage.stageCode).toBe('INSPECTION_HELD');
    expect(stage.blockedReasons).toEqual([CLAIM_HOLD]);
  });

  it('무검사 품목 LOT 에 보류를 걸었으면 INSPECTION_HELD 다 — 결과가 나올 때까지 입고 단추가 없다', () => {
    const stage = lotStage(
      facts({ inspectionRequired: false, inspectionStatusCode: null, openHolds: [CLAIM_HOLD] }),
    );
    expect(stage).toEqual({ stageCode: 'INSPECTION_HELD', nextActionCode: null, blockedReasons: [CLAIM_HOLD] });
  });

  it('합격(NORMAL)이면 RECEIPT_READY · POST_RECEIPT 다', () => {
    expect(lotStage(facts({ lotStatusCode: 'NORMAL', inspectionStatusCode: 'COMPLETED', openHolds: [] }))).toEqual({
      stageCode: 'RECEIPT_READY',
      nextActionCode: 'POST_RECEIPT',
      blockedReasons: [],
    });
  });

  it('불량(DEFECTIVE) LOT 은 RECEIPT_READY 다 — 불량창고로 입고해 처분을 기다린다', () => {
    for (const inspectionRequired of [true, false]) {
      const stage = lotStage(facts({ lotStatusCode: 'DEFECTIVE', inspectionRequired, openHolds: [CLAIM_HOLD] }));
      expect(stage).toEqual({ stageCode: 'RECEIPT_READY', nextActionCode: 'POST_RECEIPT', blockedReasons: [] });
    }
  });

  it('무검사 품목 LOT 은 의뢰 없이 RECEIPT_READY 다', () => {
    const stage = lotStage(
      facts({ lotStatusCode: 'NORMAL', inspectionRequired: false, inspectionStatusCode: null, openHolds: [] }),
    );
    expect(stage.stageCode).toBe('RECEIPT_READY');
  });

  it('일부만 입고했으면 RECEIPT_READY 로 남는다 — 적치 대기가 있어도 가장 뒤처진 단계를 말한다', () => {
    const stage = lotStage({ ...received(['PENDING']), receivableQty: new Prisma.Decimal('0.5') });
    expect(stage.stageCode).toBe('RECEIPT_READY');
  });

  it('다 입고하고 적치 PENDING 이면 PUTAWAY_PENDING · PUTAWAY 다 — 끝난 작업이 함께 있어도 그렇다', () => {
    expect(lotStage(received(['COMPLETED', 'PENDING']))).toEqual({
      stageCode: 'PUTAWAY_PENDING',
      nextActionCode: 'PUTAWAY',
      blockedReasons: [],
    });
  });

  it('임시 적치만 남았으면 PUTAWAY_TEMPORARY · PUTAWAY 다', () => {
    expect(lotStage(received(['COMPLETED_TEMPORARY', 'COMPLETED']))).toEqual({
      stageCode: 'PUTAWAY_TEMPORARY',
      nextActionCode: 'PUTAWAY',
      blockedReasons: [],
    });
  });

  it('적치가 다 끝나면 COMPLETED 다', () => {
    expect(lotStage(received(['COMPLETED'])).stageCode).toBe('COMPLETED');
  });

  it('받을 수량이 0 이고 적치도 없으면 COMPLETED 다 — 선별로 전량이 자식에게 갔다', () => {
    expect(lotStage(received([])).stageCode).toBe('COMPLETED');
  });
});

describe('labelStage — LOT 이 없는 입하 라인', () => {
  it('라벨 발행 대기이고 다음 할 일은 라벨 발행이다', () => {
    expect(labelStage(false)).toEqual({ stageCode: 'LABEL_PENDING', nextActionCode: 'ISSUE_LABEL', blockedReasons: [] });
  });

  it('입하가 취소됐거나 취소 요청 중이면 CANCELLED 다', () => {
    expect(labelStage(true)).toEqual({ stageCode: 'CANCELLED', nextActionCode: null, blockedReasons: [] });
  });
});

describe('stageGroupOf — 칩의 다섯 묶음', () => {
  it('라벨 대기는 LABEL, 검사 셋은 INSPECTION, 보류는 HELD, 입고 대기는 RECEIPT, 적치 둘은 PUTAWAY 다', () => {
    expect(stageGroupOf('LABEL_PENDING')).toBe('LABEL');
    expect(stageGroupOf('INSPECTION_REQUIRED')).toBe('INSPECTION');
    expect(stageGroupOf('INSPECTION_REQUESTED')).toBe('INSPECTION');
    expect(stageGroupOf('INSPECTION_IN_PROGRESS')).toBe('INSPECTION');
    expect(stageGroupOf('INSPECTION_HELD')).toBe('HELD');
    expect(stageGroupOf('RECEIPT_READY')).toBe('RECEIPT');
    expect(stageGroupOf('PUTAWAY_PENDING')).toBe('PUTAWAY');
    expect(stageGroupOf('PUTAWAY_TEMPORARY')).toBe('PUTAWAY');
  });

  it('완료·취소는 어느 묶음에도 들지 않는다', () => {
    expect(stageGroupOf('COMPLETED')).toBeNull();
    expect(stageGroupOf('CANCELLED')).toBeNull();
  });
});
