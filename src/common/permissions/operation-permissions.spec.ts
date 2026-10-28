import { ContractRegistry } from '../contract';
import { DERIVED_PERMISSIONS } from './derived-permissions';
import { MANUAL_PERMISSIONS } from './manual-permissions';
import { OPERATION_PERMISSIONS } from './operation-permissions';
import { PERMISSION_CODES } from './permissions';

describe('오퍼레이션 권한 매핑', () => {
  const registry = ContractRegistry.load();
  const entries = Object.entries(OPERATION_PERMISSIONS);

  it('⭐ 모든 오퍼레이션이 계약에 실재한다', () => {
    expect(entries.filter(([key]) => !registry.has(key)).map(([key]) => key)).toEqual([]);
  });

  it('⭐ 모든 권한 코드가 117 목록 안에 있다 — 없는 코드는 아무 효과가 없다', () => {
    const unknown = entries.flatMap(([key, permissions]) =>
      permissions.filter((code) => !PERMISSION_CODES.has(code)).map((code) => `${key} → ${code}`),
    );

    expect(unknown).toEqual([]);
  });

  it('빈 권한 목록이 없다 — 빈 배열은 「아무도 못 한다」가 되어 조용히 잠근다', () => {
    expect(entries.filter(([, permissions]) => permissions.length === 0)).toEqual([]);
  });

  it('⛔ 수동표가 도출표의 권한을 되풀이하지 않는다 — 도출이 이미 답을 준 자리다', () => {
    // 같은 «키»를 적는 것은 막지 않는다. 도출표는 요구서 §3 의 화면 «액션»만 담아
    // 「그 목록을 소유한 화면」이 빠지는 자리가 있다(`GET /app/users` 의 `W-CO-02`).
    // 막아야 하는 것은 같은 키에 같은 «권한»을 다시 적는 것 — 그건 순수한 중복이다.
    const repeated = Object.entries(MANUAL_PERMISSIONS).flatMap(([key, permissions]) =>
      permissions.filter((code) => (DERIVED_PERMISSIONS[key] ?? []).includes(code)),
    );

    expect(repeated).toEqual([]);
  });

  it('⭐ 두 표가 합집합으로 겹친다 — 덮어쓰기면 도출된 화면이 조용히 빠진다', () => {
    const shared = Object.keys(MANUAL_PERMISSIONS).filter((key) => key in DERIVED_PERMISSIONS);

    // 겹치는 키가 하나도 없으면 아래 루프가 아무것도 검사하지 않는다 — 헛통과를 막는다.
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) {
      expect(OPERATION_PERMISSIONS[key]).toEqual(
        expect.arrayContaining([...DERIVED_PERMISSIONS[key], ...MANUAL_PERMISSIONS[key]]),
      );
    }
  });

  it('⭐ 계약이 403 을 선언한 자리가 «전건» 등록됐다 — 게이트가 완성됐다', () => {
    const declares403 = registry.keys().filter((key) => {
      const responses = (registry.get(key)?.operation as { responses?: Record<string, unknown> })
        .responses;
      return responses !== undefined && '403' in responses;
    });
    const missing = declares403.filter((key) => !(key in OPERATION_PERMISSIONS));

    // 253 → 250(a6a87e1) — 403 을 선언하던 물류 취소 6건이 다형 2건으로, 실적 정정 승인
    // 상신 1건이 늘어 합이 셋 줄었다.
    // FR-005 이행 공장 지정 PUT의 403 선언 1건 추가.
    // SHIP-UNIT-01 출하 단위 6건(장부 P-24) — 전부 `P-04-05` 소유다: 257.
    // 테스트용 ERP W/O 등록 1건(장부 P-30) — `W-02-01` 소유다: 258.
    // 재작업 W/O 발행 1건(장부 P-33) — `W-03-10` 소유다: 259.
    // 계정-작업자 연결 치환 1건(장부 P-38) — `W-CO-02` 소유다: 260.
    // IQC 생략 실행 1건(장부 P-36) — `W-01-02` 소유다: 261.
    // 불량 기록 등록 1건(장부 P-42) — `W-01-01` 소유다: 262.
    // 품목 설비·금형 매핑 등록·수정 2건(장부 P-61) — `W-06-05` 소유다: 264.
    // ERP W/O 자동 계획 재시도 1건(장부 P-67) — `W-02-01`·`W-02-02` 소유다: 265.
    // 특채 요청·적용 2건(장부 P-79) — `W-03-10` 소유다: 267.
    // OQC 생략 요청·실행 2건(#119 · 장부 P-83) — `W-04-03` 소유다: 269.
    // 품목 검사 수준 지정·수동 변경 2건(#64 · 장부 P-87) — `W-03-12` 소유다: 271.
    // 부서×이벤트 알림 설정 4건(#160 · 장부 P-92) — `W-CO-11` 소유다: 275.
    // Zalo 연결 2건(#160 · 장부 P-96) — `W-CO-12` 소유다: 277.
    // 발송 이력 2건(#160 · 장부 P-98) — `W-CO-13` 소유다: 279.
    // 시리얼 OQC 스캔·의뢰의 시리얼 판정 2건(#68 · 장부 P-101) — `W-04-03`·`P-04-06` 소유다: 281.
    // 검사표 기준 등록·수정·확정 3건(#89 · 장부 P-102) — `W-06-24` 소유다: 284.
    // 검사표 열기·머리·단계·NG 4건(#89 · 장부 P-102) — `P-02-15`·`W-03-13` 소유다: 288.
    // 검사표 서명·승인·확인·승인 취소 4건(#89 · 장부 P-102) — `W-03-14` 소유다: 292.
    // 작업 세션 강제 종료 1건(장부 P-108) — `W-02-05` 소유다: 293.
    // 입고 줄·출하 줄 현황 2건(장부 P-119) — `W-02-09` 소유다: 295.
    // 정방향·역방향 목록·사슬 4건(장부 P-119) — `W-02-09` 소유다: 299.
    // W/O 일자별 실적 1건(장부 P-122) — `W-02-05`·`W-02-08` 소유다: 300.
    // 검사기준 작성중 버전 취소 1건(#198 · 장부 P-128) — `W-06-02` 소유다: 301.
    // 검사기준 엑셀 올리기 1건(#199 · 장부 P-131) — `W-06-02` 소유다: 302.
    expect(declares403).toHaveLength(302);
    // ⭐ 2026-09-09 — 미등록이 0 이 됐다. 옛 단언은 `covered.length >= 152` 하한이라 «되돌려도
    // 안 깨지는» 절이 됐다. 전건 일치로 조인다 — 새 오퍼레이션이 403 을 선언하면서 권한을
    // 안 등록하면 여기서 **이름째** 드러난다.
    // ⛔ 그 자리가 비면 `permission.guard.ts:48` 이 «런타임에» Error 를 던진다(공유계약 F-6).
    //    던짐 자체는 `permission.guard.spec.ts` 가 단위로 잡는다 — e2e 로는 더 이상 못 만든다.
    expect(missing).toEqual([]);
  });

  /**
   * ⭐ 계약이 «이름 적은» 호출 셸이 빠지면 그 화면 담당자가 조용히 403 을 받는다. 도출표는
   * 요구서 §3 에서 나오므로 계약 description 만 아는 셸은 잡히지 않는다 — 통보 181·189 가
   * 그 사고 둘이다. 수동표에 넣어도 «아무것도 그것을 지키지 않아» 지우면 그대로 사라진다.
   */
  it('⛔ 결재함 목록에 계약이 이름 적은 호출 셸 넷이 전부 있다 — 통보 189', () => {
    // `get.description` 「부르는 셸이 «둘»이다 — 관리웹 결재함(W-CO-09)과 모바일 상신 화면
    // (M-01-13 의 「내가 올린 요청」 구획)」 · `assignedToMe` 「승인 화면은 관리웹뿐이라
    // (W-CO-09·W-01-02·W-03-09)」.
    expect(OPERATION_PERMISSIONS['GET /app/approval-requests']).toEqual(
      expect.arrayContaining(['W-CO-09', 'M-01-13', 'W-01-02', 'W-03-09']),
    );
  });

  /**
   * ⛔ 위 189 와 «같은 사고»의 나머지 반쪽이다. `W-03-10` 은 DR-008 로 2026-08-13 «신설»돼 도출
   * 원천(요구서 §3)보다 새것이라 한 줄도 안 도출됐다. ⭐ 아래 넷 중 **조회 셋은 계약이 403 을
   * 선언하지 않아 `permission.guard.ts:40` 이 아예 보지 않는다** — 즉 **e2e 로는 영영 반증되지
   * 않는다.** 그 세 줄을 지켜 주는 것이 이 단언 하나뿐이다(PR #457 리뷰 Major-1).
   */
  it('⛔ 처분 판정 처리(W-03-10)가 계약이 이름 적은 네 자리에 전부 있다 — 통보 181', () => {
    for (const key of [
      'POST /quality/nonconformances/{nonconformanceId}/disposition-decisions',
      'GET /quality/nonconformances/{nonconformanceId}/disposition-decisions',
      'GET /quality/nonconformances',
      'GET /quality/nonconformances/{nonconformanceId}',
    ]) {
      expect(OPERATION_PERMISSIONS[key]).toContain('W-03-10');
    }
  });

  it('⛔ 발행 POST에 재구성 라벨과 검사성적서 호출 셸이 모두 있다 — I-27 R11', () => {
    expect(OPERATION_PERMISSIONS['POST /app/document-issues']).toEqual(
      expect.arrayContaining(['P-04-04', 'W-04-03']),
    );
  });

  // `:per-line` 이 빌려 쓰는 입하 등록 권한 — PDA(M-01-01)와 웹 입하 등록(W-01-03) 둘 다(장부 P-117).
  it('⛔ 입하 등록에 PDA 와 웹 입하 등록 화면이 함께 있다 — 장부 P-117', () => {
    expect(OPERATION_PERMISSIONS['POST /logistics/inbound-receipts']).toEqual(['M-01-01', 'W-01-03']);
  });

  // 결재 화면(W-03-09)에서 승인한 뒤 실행 · 적용까지 잇는다 — IQC 생략 실행과 같은 짜임(장부 P-127 · omf-all-around#193).
  it('⛔ OQC 생략 실행 · 특채 적용에 결재 화면이 함께 있다 — 장부 P-127', () => {
    // 순서는 도출표와 수동 표를 합친 차례라 뜻이 없다 — 화면 집합으로 본다.
    const screensOf = (operation: string): string[] => [...(OPERATION_PERMISSIONS[operation] ?? [])].sort();
    expect(screensOf('POST /logistics/shipment-requests/{shipmentRequestId}:skip-oqc')).toEqual(['W-03-09', 'W-04-03']);
    expect(screensOf('POST /quality/concessions/{concessionId}:apply')).toEqual(['W-03-09', 'W-03-10']);
  });

  // P-06-01(창고 적재 위치 라벨 발행)은 설계 밖 화면이라 도출표가 영영 주지 않는다 — 장부 P-28.
  it('⛔ 발행 POST에 창고 적재 위치 라벨 발행 화면이 있다 — 장부 P-28', () => {
    expect(OPERATION_PERMISSIONS['POST /app/document-issues']).toContain('P-06-01');
  });

  // W-03-11(PQC 검사 등록·조회)은 설계 밖 관리웹 화면이다 — 장부 P-51. 도출된 화면이 빠지지 않아야 한다.
  it('⛔ 검사 결과 저장에 관리웹 PQC 화면이 도출된 화면들과 함께 있다 — 장부 P-51', () => {
    expect(OPERATION_PERMISSIONS['POST /quality/inspection-results']).toEqual(
      expect.arrayContaining(['P-02-13', 'W-01-01', 'W-04-03', 'W-03-11']),
    );
  });

  // W-06-16~23(ERP 데이터 조회 8)은 IA 밖에서 생긴 관리웹 화면이다 — 장부 P-71. 그 화면이 부르는 조회는 계약에
  // 403 이 없어 지금은 게이트가 보지 않는다. 사본이 403 을 붙이면 여기가 빨개진다 — 그때 W-06-16~23 만 가진 역할을
  // 지키는 것은 아래 시험(도출표가 이미 그 화면을 싣는다)이다.
  it('⛔ ERP 데이터 조회 화면 여덟이 부르는 조회는 계약에 403 이 없다 — 장부 P-71', () => {
    const reads = [
      'GET /mdm/code-groups',
      'GET /mdm/code-values',
      'GET /mdm/workers',
      'GET /mdm/workers/{workerId}',
      'GET /mdm/items',
      'GET /mdm/items/{itemId}',
      'GET /mdm/partners',
      'GET /mdm/partners/{partnerId}',
      'GET /mdm/partners/{partnerId}/roles',
      'GET /mdm/plants',
      'GET /mdm/business-units',
      'GET /mdm/uoms',
      'GET /planning/boms',
      'GET /planning/boms/{bomId}/components',
      'GET /logistics/purchase-orders',
      'GET /logistics/purchase-orders/{purchaseOrderId}',
      'GET /logistics/sales-orders',
      'GET /logistics/sales-orders/{salesOrderId}',
      'GET /planning/production-orders',
      'GET /planning/production-orders/{productionOrderId}',
    ];
    // 오타 난 키는 403 이 «없어» 보인다 — 헛통과를 막는다.
    expect(reads.filter((key) => !registry.has(key))).toEqual([]);

    const gated = reads.filter((key) => {
      const responses = (registry.get(key)?.operation as { responses?: Record<string, unknown> })
        .responses;
      return responses !== undefined && '403' in responses;
    });
    expect(gated).toEqual([]);
  });

  // 요구서 §3-15~§3-22(설계 omf-mes#666)가 화면마다 부르는 조회를 적었고, 도출표가 그것을 옮겼다. 이 화면 코드만
  // 가진 역할이 자기 화면의 조회를 «하나라도» 못 부르면 그 탭이 빈 표나 이름 없는 코드로 선다.
  it('⛔ ERP 데이터 조회 화면 여덟이 자기가 부르는 조회에 실려 있다 — 장부 P-71', () => {
    const readsByScreen: Record<string, string[]> = {
      'W-06-16': ['GET /mdm/workers', 'GET /mdm/workers/{workerId}'],
      'W-06-17': ['GET /mdm/items', 'GET /mdm/items/{itemId}', 'GET /mdm/code-values', 'GET /mdm/uoms'],
      'W-06-18': [
        'GET /planning/boms',
        'GET /planning/boms/{bomId}/components',
        'GET /mdm/items',
        'GET /mdm/items/{itemId}',
        'GET /mdm/code-values',
        'GET /mdm/uoms',
      ],
      'W-06-19': [
        'GET /mdm/partners',
        'GET /mdm/partners/{partnerId}',
        'GET /mdm/partners/{partnerId}/roles',
      ],
      'W-06-20': ['GET /mdm/code-groups', 'GET /mdm/code-values'],
      'W-06-21': [
        'GET /logistics/purchase-orders',
        'GET /logistics/purchase-orders/{purchaseOrderId}',
        'GET /mdm/partners',
        'GET /mdm/plants',
        'GET /mdm/uoms',
        'GET /mdm/items/{itemId}',
        'GET /mdm/code-values',
      ],
      'W-06-22': [
        'GET /logistics/sales-orders',
        'GET /logistics/sales-orders/{salesOrderId}',
        'GET /mdm/partners',
        'GET /mdm/uoms',
        'GET /mdm/items/{itemId}',
        'GET /mdm/code-values',
      ],
      'W-06-23': [
        'GET /planning/production-orders',
        'GET /planning/production-orders/{productionOrderId}',
        'GET /mdm/items',
        'GET /mdm/items/{itemId}',
        'GET /mdm/business-units',
        'GET /mdm/plants',
        'GET /mdm/uoms',
        'GET /mdm/code-values',
      ],
    };

    const missing = Object.entries(readsByScreen).flatMap(([screen, keys]) =>
      keys
        .filter((key) => !(OPERATION_PERMISSIONS[key] ?? []).includes(screen))
        .map((key) => `${screen} → ${key}`),
    );
    expect(missing).toEqual([]);
  });

  it('⛔ 실사 치환과 마감은 서로 다른 소유 화면을 쓴다 — I-15 통보 274·275', () => {
    expect(OPERATION_PERMISSIONS['PUT /inventory/counts/{inventoryCountId}/lines']).toEqual([
      'M-01-11',
    ]);
    expect(OPERATION_PERMISSIONS['POST /inventory/counts/{inventoryCountId}:close']).toEqual([
      'W-01-04',
    ]);
  });

  it('⛔ 배포 화면(W-02-04)이 다시 읽는 유효성·상세를 부를 수 있다 — PLAN-WO-01 W6', () => {
    for (const key of [
      'GET /production/work-orders/{workOrderId}/validation',
      'GET /production/work-orders/{workOrderId}',
    ]) {
      // 도출된 화면이 빠지면 안 된다 — 합집합이어야 한다.
      expect(OPERATION_PERMISSIONS[key]).toEqual(expect.arrayContaining([...DERIVED_PERMISSIONS[key], 'W-02-04']));
    }
  });
});
