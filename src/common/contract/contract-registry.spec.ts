import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContractRegistry, defaultContractsDir } from './contract-registry';

describe('ContractRegistry', () => {
  const registry = ContractRegistry.load();

  // ⛔ 계약이 바뀌면 이 수치부터 깨진다 — 그것이 이 검사의 뜻이다. 고치기 전에
  // 「무엇이 늘고 줄었나」를 `pnpm contracts:check` 로 확인한다.
  // 490(6d03a44) → 487(a6a87e1) — 물류 문서별 취소 6건이 다형 2건으로 합쳐지고(-4)
  // 실적 정정 승인 상신 1건이 늘었다(+1). FR-005 이행 공장 지정 PUT 1건 추가: 488.
  // SHIP-UNIT-01 출하 단위 6건을 사본에 선반영했다(장부 P-24): 494.
  // 테스트용 ERP W/O 등록 1건(장부 P-30): 495.
  // 재작업 W/O 발행 1건(장부 P-33): 496. 계정-작업자 연결 2건(장부 P-38): 498. 검사 대상 이력 1건(#61 · 장부 P-55): 499. IQC 생략 실행 1건(장부 P-36): 500. 불량 기록 등록 1건(#106 · 장부 P-42): 501. 품목 설비·금형 매핑 3건 + 4M 추천 1건(장부 P-61): 505. 자재 LOT 영향 범위 1건(#108 · 장부 P-52): 506.
  // ERP W/O 자동 계획 재시도 1건(장부 P-67): 507. 특채 요청·적용 2건(#84 · 장부 P-79): 509. OQC 생략 요청·실행 2건(#119 · 장부 P-83): 511. 품목 검사 수준 3건 + 전환 이력 1건(#64 · 장부 P-87): 515. 부서×이벤트 알림 설정 4건(#160 · 장부 P-92): 519. Zalo 연결 2건(#160 · 장부 P-96): 521. 발송 이력 2건(#160 · 장부 P-98): 523. 시리얼 OQC 조회 2건(#68 · 장부 P-101): 525. 검사표 기준 5건(#89 · 장부 P-102): 530. 검사표 입력 5건(#89 · 장부 P-102): 535. 검사표 목록·서명 5건(#89 · 장부 P-102): 540. 투입 자재 계보 조회 3건(#166 · 장부 P-107): 543. 작업 세션 강제 종료 1건(장부 P-108): 544. 발주 하나의 입고 진행 1건(#805 · 장부 P-110): 545. 입고 단계 칩의 수 1건(#805 · 장부 P-110): 546. 입고 줄·출하 줄 현황 2건(장부 P-119): 548. 정방향·역방향 4건(장부 P-119): 552. W/O 일자별 실적 1건(장부 P-122): 553. 검사기준 작성중 버전 취소 1건(#198 · 장부 P-128): 554. 인계 작업 종류·인계작업 알림 설정 4건(#190 · 장부 P-134): 558. 단말 작업 수 1건(#190 · 장부 P-137): 559. 검사기준 엑셀 올리기 1건(#199 · 장부 P-140): 560. 기간별 이력의 투입 줄·포장 줄 2건(장부 P-151): 562. PQC 생략 요청·실행 2건(#212 · 장부 P-152): 564.
  // 위치 랙 만들기·지우기 2건(위치 ③b): 566. 위치 이동 1건(위치 ⑤): 567. 위치 품목 제한 2건: 569.
  // 적치 규칙 7건 제거(사용자 결정 2026-10-29): 562.
  // 입하 예정 P/O 라인 목록 1건(#741 · 장부 P-78): 563.
  it('계약 7파일에서 오퍼레이션 563건을 적재한다', () => {
    expect(registry.size).toBe(563);
  });

  it('METHOD path 키가 유일하다 — 파일이 겹쳐도 덮어쓰지 않는다', () => {
    // load() 가 겹침을 던지므로 여기까지 왔다는 것이 유일성의 증거다. 건수로 한 번 더 본다.
    expect(new Set(registry.keys()).size).toBe(registry.size);
  });

  it('템플릿 경로를 그대로 보존한다 — 중괄호를 풀면 계약과 대조할 수 없다', () => {
    const operation = registry.get('GET /app/roles/{roleId}');

    expect(operation).toMatchObject({
      method: 'GET',
      path: '/app/roles/{roleId}',
      source: 'mdm-기준정보.json',
    });
  });

  it('오퍼레이션 본문을 들고 있다 — 검증기가 여기서 스키마를 꺼낸다', () => {
    expect(registry.get('GET /app/permissions')?.operation).toHaveProperty('responses');
  });

  it('없는 키는 undefined 를 준다', () => {
    expect(registry.get('GET /없는/경로')).toBeUndefined();
    expect(registry.has('GET /없는/경로')).toBe(false);
  });

  it('계약 파일이 없는 디렉터리는 던진다 — 「0건 적재」를 정상으로 넘기지 않는다', () => {
    const empty = mkdtempSync(join(tmpdir(), 'contracts-'));

    expect(() => ContractRegistry.load(empty)).toThrow(/계약 파일이 없다/);
  });

  it('같은 오퍼레이션이 두 파일에 있으면 던진다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    const document = JSON.stringify({ paths: { '/x': { get: { summary: 'x' } } } });
    writeFileSync(join(dir, 'a.json'), document);
    writeFileSync(join(dir, 'b.json'), document);

    expect(() => ContractRegistry.load(dir)).toThrow(/겹친다: GET \/x/);
  });

  it('기본 경로가 저장소 루트의 contracts 다 — 운영 이미지의 /app/contracts 와 같은 상대 경로', () => {
    expect(defaultContractsDir()).toBe(join(process.cwd(), 'contracts'));
  });
});
