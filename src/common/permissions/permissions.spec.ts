import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERMISSIONS, PERMISSION_CODES } from './permissions';

/** 계약 원본에서 PermissionListResponse 스키마를 꺼낸다 — 손으로 옮기면 그 순간 드리프트한다. */
function contractValidator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../../../contracts/mdm-기준정보.json'), 'utf8'),
  ) as { components: { schemas: Record<string, unknown> } };

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'contract', components: contract.components });

  return ajv.compile({ $ref: 'contract#/components/schemas/PermissionListResponse' });
}

describe('기능 권한 목록', () => {
  it('권한이 117건이다 — 설계 자료 실측치와 같다', () => {
    expect(PERMISSIONS).toHaveLength(117);
  });

  it('도메인 축이 7개이고 축별 건수가 설계 자료와 같다', () => {
    const byGroup = PERMISSIONS.reduce<Record<string, number>>((acc, permission) => {
      acc[permission.groupCode] = (acc[permission.groupCode] ?? 0) + 1;
      return acc;
    }, {});

    // 권한목록.md 의 절 제목이 선언한 건수. 그쪽이 바뀌면 여기도 바뀌어야 한다.
    expect(byGroup).toEqual({ '01': 26, '02': 24, '03': 6, '04': 18, '05': 17, '06': 14, CO: 12 });
  });

  it('code 가 유일하다 — 격자 열이 겹치면 부여가 어느 쪽에 가는지 알 수 없다', () => {
    expect(PERMISSION_CODES.size).toBe(PERMISSIONS.length);
  });

  it('code 가 계약 maxLength 50 안에 든다', () => {
    const tooLong = PERMISSIONS.filter((permission) => permission.code.length > 50);

    expect(tooLong).toEqual([]);
  });

  it('name 이 비어 있지 않다 — 격자 열 머리를 서버가 준다', () => {
    const blank = PERMISSIONS.filter((permission) => permission.name.trim() === '');

    expect(blank).toEqual([]);
  });

  it('PERMISSION_CODES 가 PERMISSIONS 와 같은 집합이다', () => {
    expect([...PERMISSION_CODES].sort()).toEqual(PERMISSIONS.map((p) => p.code).sort());
  });

  it('⭐ 목록이 계약 PermissionListResponse 스키마를 만족한다', () => {
    const validate = contractValidator();

    expect(validate({ items: PERMISSIONS })).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('계약 스키마 검증기가 실제로 거른다 — 위 검사가 헛통과가 아님을 보인다', () => {
    const validate = contractValidator();

    expect(validate({ items: [{ code: 'X' }] })).toBe(false);
    expect(validate({})).toBe(false);
  });
});
