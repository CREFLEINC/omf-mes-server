import { join } from 'node:path';

import { collectContractBindings } from './contract-bindings';
import { Contract } from './contract.decorator';

const SRC = join(__dirname, '../..');
const FIXTURES = join(__dirname, '__fixtures__');

describe('collectContractBindings', () => {
  it('@Contract 가 붙은 핸들러를 클래스·메서드 이름과 함께 모은다', async () => {
    const bindings = await collectContractBindings(FIXTURES);

    expect(bindings).toEqual([
      { key: 'GET /app/permissions', handler: 'ProbeController.bound', source: 'probe.controller.ts' },
      { key: 'GET /없는/경로', handler: 'ProbeController.phantom', source: 'probe.controller.ts' },
    ]);
  });

  it('@Contract 가 없는 메서드는 세지 않는다', async () => {
    const bindings = await collectContractBindings(FIXTURES);

    expect(bindings.map((binding) => binding.handler)).not.toContain('ProbeController.unbound');
  });

  it('픽스처는 실제 계수에서 빠진다 — 계수기가 자기 시험용을 세면 수치를 못 믿는다', async () => {
    const bindings = await collectContractBindings(SRC);

    expect(bindings.map((binding) => binding.handler)).not.toContain('ProbeController.bound');
  });
});

describe('@Contract 표기 검사', () => {
  it('METHOD path 가 아니면 던진다 — 어긋난 표기는 레지스트리에서 못 찾아 조용히 무검증이 된다', () => {
    expect(() => Contract('/trace/lots')).toThrow(/METHOD \/path/);
    expect(() => Contract('POST trace/lots')).toThrow();
    expect(() => Contract('FETCH /trace/lots')).toThrow();
  });

  it('올바른 표기는 통과한다', () => {
    expect(() => Contract('POST /trace/lots')).not.toThrow();
    expect(() => Contract('GET /app/roles/{roleId}')).not.toThrow();
  });
});
