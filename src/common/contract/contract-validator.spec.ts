import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODE } from '../errors';
import { ContractRegistry } from './contract-registry';
import { ContractValidator } from './contract-validator';

describe('ContractValidator', () => {
  const registry = ContractRegistry.load();
  const validator = new ContractValidator(registry);

  it('⭐ 계약 490건이 전부 컴파일된다 — 스키마 결함이 부팅 때 드러난다', () => {
    expect(validator.compileAll()).toBe(registry.size);
  });

  describe('본문', () => {
    const key = 'POST /app/roles';

    it('정상 요청은 오류가 없다', () => {
      expect(validator.validate(key, { body: { roleCode: 'ROLE_X', roleName: '역할' } })).toEqual(
        [],
      );
    });

    it('필수 누락을 REQUIRED 로, 빠진 칸 이름과 함께 낸다', () => {
      const errors = validator.validate(key, { body: { roleCode: 'ROLE_X' } });

      expect(errors).toEqual([
        { scope: 'field', field: 'roleName', code: ERROR_CODE.REQUIRED, message: expect.any(String) },
      ]);
    });

    it('길이 초과를 RANGE 로 낸다', () => {
      const errors = validator.validate(key, {
        body: { roleCode: 'X'.repeat(51), roleName: '역할' },
      });

      expect(errors).toMatchObject([{ scope: 'field', field: 'roleCode', code: ERROR_CODE.RANGE }]);
    });

    it('타입 위반을 INVALID 로 낸다', () => {
      const errors = validator.validate(key, { body: { roleCode: 1, roleName: '역할' } });

      expect(errors).toMatchObject([
        { scope: 'field', field: 'roleCode', code: ERROR_CODE.INVALID },
      ]);
    });

    it('본문은 타입을 강제 변환하지 않는다 — JSON 은 타입이 이미 뜻을 갖는다', () => {
      // description 은 ["string","null"] 이다. 강제 변환이 켜져 있으면 5 가 "5" 로
      // 바뀌어 통과해 버린다 — 질의 쪽과 달리 본문은 그것을 허용하지 않는다.
      const errors = validator.validate(key, {
        body: { roleCode: 'ROLE_X', roleName: '역할', description: 5 },
      });

      expect(errors).toMatchObject([{ field: 'description', code: ERROR_CODE.INVALID }]);
    });

    it('계약이 안 받는 프로퍼티는 막지 않는다 — 계약이 additionalProperties 를 거의 안 쓴다', () => {
      // 예: RoleUpdate 는 isActive 를 받지 않는다(:deactivate 로만 바꾼다). 그래도 거절하지
      // 않는다 — 계약 전 파일에 additionalProperties 가 한 자리뿐이라 이것이 계약의 뜻이다.
      const errors = validator.validate('PUT /app/roles/{roleId}', {
        params: { roleId: '7' },
        body: { roleCode: 'ROLE_X', roleName: '역할', isActive: false },
      });

      expect(errors).toEqual([]);
    });

    it('여러 칸이 틀리면 한꺼번에 낸다 — 화면이 하나씩 고치며 왕복하지 않게 한다', () => {
      const errors = validator.validate(key, { body: {} });

      expect(errors.map((error) => error.field).sort()).toEqual(['roleCode', 'roleName']);
    });

    it('⭐ 중첩 배열은 lines[0].itemId 로 짚는다 — JSON 포인터가 아니라 화면이 쓰는 이름', () => {
      const errors = validator.validate('POST /logistics/shipment-requests', {
        body: {
          customerId: 1,
          shipToPartnerId: 2,
          requestedShipDate: '2026-09-02',
          lines: [{ requestedQty: 1, allocatedQty: 0, uomId: 3, shippingInspectionRequired: false }],
        },
      });

      expect(errors).toEqual([
        {
          scope: 'field',
          field: 'lines[0].itemId',
          code: ERROR_CODE.REQUIRED,
          message: expect.any(String),
        },
      ]);
    });

    it('본문을 받지 않는 오퍼레이션은 본문을 보지 않는다', () => {
      expect(validator.validate('GET /app/permissions', { body: { 아무거나: 1 } })).toEqual([]);
    });
  });

  describe('질의·경로 파라미터', () => {
    it('질의는 문자열로 오므로 강제 변환한다 — 안 하면 integer 가 전부 틀린다', () => {
      const errors = validator.validate('GET /app/approval-routes', {
        query: { businessUnitId: '10', activeOnly: 'true', page: '1' },
      });

      expect(errors).toEqual([]);
    });

    it('enum 위반을 INVALID 로 낸다', () => {
      const errors = validator.validate('GET /app/approval-routes', {
        query: { approvalTypeCode: '없는유형' },
      });

      expect(errors).toMatchObject([{ field: 'approvalTypeCode', code: ERROR_CODE.INVALID }]);
    });

    it('계약에 없는 질의 파라미터는 막지 않는다', () => {
      expect(validator.validate('GET /app/approval-routes', { query: { 추적용: 'x' } })).toEqual([]);
    });

    it('⭐ path-item 레벨에만 선언된 경로 파라미터도 검증한다 — 171자리가 그 형태다', () => {
      const errors = validator.validate('GET /app/roles/{roleId}', {
        params: { roleId: '숫자아님' },
      });

      expect(errors).toMatchObject([{ field: 'roleId', code: ERROR_CODE.INVALID }]);
    });

    it('경로 파라미터가 맞으면 통과한다', () => {
      expect(validator.validate('GET /app/roles/{roleId}', { params: { roleId: '7' } })).toEqual([]);
    });
  });

  describe('선택 본문', () => {
    // 계약 전면에 `requestBody.required: false` 는 이 한 자리뿐이다(실측).
    const key = 'POST /app/approval-requests/{approvalRequestId}:approve';

    it('본문을 아예 안 보내도 통과한다 — 계약이 requestBody.required=false 로 열었다', () => {
      // body-parser 2 는 본문 없는 요청에 `req.body` 를 undefined 로 둔다. 스키마로는
      // 못 가른다 — `required: []` 인 객체 스키마도 undefined 는 「객체가 아니다」다.
      expect(validator.validate(key, { params: { approvalRequestId: '7' } })).toEqual([]);
    });

    it('보낸 본문은 그대로 검증한다 — 열린 것은 «부재»뿐이다', () => {
      expect(
        validator.validate(key, { params: { approvalRequestId: '7' }, body: { comment: 1 } }),
      ).toMatchObject([{ field: 'comment', code: ERROR_CODE.INVALID }]);
    });

    it('본문 필수 자리는 부재를 계속 막는다', () => {
      expect(
        validator.validate('POST /app/approval-requests/{approvalRequestId}:reject', {
          params: { approvalRequestId: '7' },
        }).length,
      ).toBeGreaterThan(0);
    });
  });


  it('⭐ 본문 필수를 가진 오퍼레이션 전건이 빈 본문을 거른다 — 표본이 아니라 전수로 본다', () => {
    // 위 검사들은 손으로 고른 몇 건이다. 스키마 해석이 «어떤 형태에서만» 맞고 나머지는
    // 조용히 통과하는 상태일 수 있어, 계약 전면에 같은 질문을 한 번 던진다.
    const silent: string[] = [];
    let checked = 0;

    for (const key of registry.keys()) {
      const entry = registry.get(key);
      const ref = (
        entry?.operation as {
          requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
        }
      ).requestBody?.content?.['application/json']?.schema?.$ref;
      if (!ref || !entry) continue;

      const schemas = (entry.document.components as { schemas?: Record<string, unknown> }).schemas;
      const schema = schemas?.[ref.split('/').pop() ?? ''] as { required?: string[] } | undefined;
      if (!schema?.required?.length) continue;

      checked += 1;
      if (validator.validate(key, { body: {} }).length === 0) silent.push(key);
    }

    expect(checked).toBeGreaterThan(100);
    expect(silent).toEqual([]);
  });

  it('계약에 없는 키는 검증하지 않는다 — 유령 바인딩은 커버리지 검사가 잡는다', () => {
    expect(validator.validate('GET /없는/경로', { body: { x: 1 } })).toEqual([]);
  });

  it('⭐ 낸 오류가 계약 ErrorResponse 스키마를 만족한다', () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../../../contracts/app-공통.json'), 'utf8'),
    ) as { components: Record<string, unknown> };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema({ $id: 'contract', components: contract.components });
    const validate = ajv.compile({ $ref: 'contract#/components/schemas/ErrorResponse' });

    const errors = validator.validate('POST /app/roles', { body: { roleCode: 1 } });

    expect(errors.length).toBeGreaterThan(0);
    expect(validate({ errors })).toBe(true);
  });
});
