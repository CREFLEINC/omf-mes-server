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

  it('⛔ 수동표가 도출표와 겹치지 않는다 — 겹치면 도출이 이미 답을 준 자리다', () => {
    const overlap = Object.keys(MANUAL_PERMISSIONS).filter((key) => key in DERIVED_PERMISSIONS);

    expect(overlap).toEqual([]);
  });

  it('⚠ 계약이 403 을 선언한 자리 중 아직 절반쯤만 등록됐다 — 나머지는 게이트가 던진다', () => {
    const declares403 = registry.keys().filter((key) => {
      const responses = (registry.get(key)?.operation as { responses?: Record<string, unknown> })
        .responses;
      return responses !== undefined && '403' in responses;
    });
    const covered = declares403.filter((key) => key in OPERATION_PERMISSIONS);

    // 이 수치가 오르면 도메인이 자기 권한을 등록했다는 뜻이다. 249 가 되면 게이트가 완성된다.
    expect(declares403).toHaveLength(249);
    expect(covered.length).toBeGreaterThanOrEqual(152);
  });
});
