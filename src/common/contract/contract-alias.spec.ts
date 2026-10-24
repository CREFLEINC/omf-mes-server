import { Reflector } from '@nestjs/core';

import { Contract, ContractAlias, contractOperationOf } from './contract.decorator';

/** 별칭은 가드가 같은 오퍼레이션으로 읽게 할 뿐이다 — 계약 바인딩(커버리지)에는 세지 않는다(장부 P-117). */
class Fixture {
  @Contract('POST /logistics/inbound-receipts')
  bound(): string {
    return 'bound';
  }

  @ContractAlias('POST /logistics/inbound-receipts')
  aliased(): string {
    return 'aliased';
  }

  @Contract('GET /logistics/inbound-receipts')
  @ContractAlias('POST /logistics/inbound-receipts')
  both(): string {
    return 'both';
  }

  plain(): string {
    return 'plain';
  }
}

describe('ContractAlias', () => {
  const reflector = new Reflector();
  const of = (name: keyof Fixture) => contractOperationOf(reflector, Fixture.prototype[name]);

  it('가드는 @Contract 와 별칭을 같은 오퍼레이션으로 읽는다', () => {
    expect(of('bound')).toBe('POST /logistics/inbound-receipts');
    expect(of('aliased')).toBe('POST /logistics/inbound-receipts');
  });

  it('둘 다 있으면 @Contract 가 먼저다 · 둘 다 없으면 계약 밖이다', () => {
    expect(of('both')).toBe('GET /logistics/inbound-receipts');
    expect(of('plain')).toBeUndefined();
  });

  it('표기가 틀리거나 경로 파라미터가 있는 오퍼레이션은 데코레이터를 만들 때 막는다', () => {
    expect(() => ContractAlias('inbound-receipts')).toThrow('METHOD /path');
    expect(() => ContractAlias('PUT /logistics/inbound-receipts/{inboundReceiptId}')).toThrow('경로 파라미터');
  });
});
