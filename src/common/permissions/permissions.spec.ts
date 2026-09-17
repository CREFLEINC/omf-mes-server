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
  it('권한이 119건이다 — 설계 자료 실측치 117 에 설계 밖 화면 2', () => {
    // 설계 밖 화면 둘을 서버가 먼저 받았다 — P-04-05(출하 단위 구성)·P-06-01(창고 적재 위치 라벨 발행).
    expect(PERMISSIONS).toHaveLength(119);
  });

  it('도메인 축이 7개이고 축별 건수가 설계 자료와 같다', () => {
    const byGroup = PERMISSIONS.reduce<Record<string, number>>((acc, permission) => {
      acc[permission.groupCode] = (acc[permission.groupCode] ?? 0) + 1;
      return acc;
    }, {});

    // 권한목록.md 의 절 제목이 선언한 건수. 그쪽이 바뀌면 여기도 바뀌어야 한다.
    expect(byGroup).toEqual({ '01': 26, '02': 24, '03': 6, '04': 19, '05': 17, '06': 15, CO: 12 });
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

  it('⭐ 시드가 역할에 붙이는 권한이 이 목록 안에 든다', () => {
    // ⛔ prisma/seed.ts 를 import 하지 않고 «글자로» 읽는다. 운영 시드는
    // `swc prisma/seed.ts -o dist/seed.js` 로 «단일 파일» transpile 되므로 seed 가 src 를
    // import 하면 운영 이미지에서 경로가 풀리지 않는다. 그래서 이 검사는 여기 있다.
    //
    // 계약 GET /app/permissions 가 경고한 자리다 — 「없는 코드를 만들면 그것을 검사하는
    // 자리가 없어 «아무 효과 없는 권한»이 된다」.
    const seed = readFileSync(join(__dirname, '../../../prisma/seed.ts'), 'utf8');
    const roles = seed.slice(seed.indexOf('const ROLES = ['), seed.indexOf('const RETIRED_ROLES'));
    const used = [...roles.matchAll(/'([A-Z]-[0-9A-Z]{2}-[0-9]{2})'/g)].map((m) => m[1]);

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((code) => !PERMISSION_CODES.has(code))).toEqual([]);
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
