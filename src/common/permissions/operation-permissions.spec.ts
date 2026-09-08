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

  it('⚠ 계약이 403 을 선언한 자리 중 아직 절반쯤만 등록됐다 — 나머지는 게이트가 던진다', () => {
    const declares403 = registry.keys().filter((key) => {
      const responses = (registry.get(key)?.operation as { responses?: Record<string, unknown> })
        .responses;
      return responses !== undefined && '403' in responses;
    });
    const covered = declares403.filter((key) => key in OPERATION_PERMISSIONS);

    // 이 수치가 오르면 도메인이 자기 권한을 등록했다는 뜻이다. 250 이 되면 게이트가 완성된다.
    // 253 → 250(a6a87e1) — 403 을 선언하던 물류 취소 6건이 다형 2건으로, 실적 정정 승인
    // 상신 1건이 늘어 합이 셋 줄었다.
    expect(declares403).toHaveLength(250);
    expect(covered.length).toBeGreaterThanOrEqual(152);
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
});
