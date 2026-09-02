import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContractRegistry, defaultContractsDir } from './contract-registry';

describe('ContractRegistry', () => {
  const registry = ContractRegistry.load();

  it('계약 7파일에서 오퍼레이션 482건을 적재한다', () => {
    expect(registry.size).toBe(482);
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
