import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectContractBindings } from './contract-bindings';
import { ContractRegistry } from './contract-registry';

const SRC = join(__dirname, '../..');

describe('계약 커버리지', () => {
  const registry = ContractRegistry.load();

  it('@Contract 바인딩이 모두 계약에 실재한다', async () => {
    const bindings = await collectContractBindings(SRC);
    const phantom = bindings.filter((binding) => !registry.has(binding.key));

    expect(phantom).toEqual([]);
  });

  it('한 오퍼레이션을 두 핸들러가 주장하지 않는다', async () => {
    const bindings = await collectContractBindings(SRC);
    const byKey = new Map<string, string[]>();
    for (const binding of bindings) {
      byKey.set(binding.key, [...(byKey.get(binding.key) ?? []), binding.handler]);
    }
    const duplicated = [...byKey].filter(([, handlers]) => handlers.length > 1);

    expect(duplicated).toEqual([]);
  });

  it('⭐ 구현 커버리지를 보고한다 (n/488)', async () => {
    const bindings = await collectContractBindings(SRC);
    const implemented = new Set(bindings.map((binding) => binding.key)).size;

    // ⛔ 지금은 «보고»다. 도메인이 다 서면 이 단언을 registry.size 로 뒤집는다 —
    // 그 전환이 「최신 계약을 만족하는 서버 구축 완료」의 정의다.
    // eslint-disable-next-line no-console
    console.log(`계약 구현 커버리지: ${implemented}/${registry.size}`);

    // ⭐ **분모를 «센다».** 이 시험 이름이 「n/490」인 채로 실제가 487 이 되도록 아무도 몰랐다
    //    (부채 #337). 계약 사본을 당겨 분모가 바뀌면 여기가 빨개지고, 그때 목표 수를 다시 잡는다.
    // FR-005 출하작업지시 이행 공장 지정 PUT 1건: 원격 main 487 → 현 사본 488.
    expect(registry.size).toBe(488);
    expect(implemented).toBeLessThanOrEqual(registry.size);
  });
});

describe('운영 이미지 불변식', () => {
  it('runtime 스테이지가 contracts 를 담는다 — 검증기가 런타임에 읽는다', () => {
    const dockerfile = readFileSync(join(SRC, '../Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM base AS runtime'));

    // 계약을 이미지에서 빼면 부팅이 「계약 파일이 없다」로 죽는다. 그 사고를 배포가
    // 아니라 여기서 잡는다 — build 스테이지에만 있고 runtime 에 없던 것이 실제 상태였다.
    expect(runtime).toMatch(/^COPY contracts \.\/contracts$/m);
  });
});
