import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CONTRACT_OPERATION } from './contract.decorator';

export interface ContractBinding {
  /** `@Contract(...)` 가 적힌 값. */
  key: string;
  /** `ItemController.create` — 어긋났을 때 어디를 볼지 말해 준다. */
  handler: string;
  source: string;
}

type Constructor = new (...args: never[]) => object;

function isConstructor(value: unknown): value is Constructor {
  return typeof value === 'function' && typeof (value as Constructor).prototype === 'object';
}

/**
 * `src` 아래 컨트롤러가 선언한 계약 바인딩을 모은다.
 *
 * Nest 애플리케이션을 띄우지 않는다 — 클래스를 임포트하는 것만으로는 DI 가 돌지 않아
 * **DB 없이** 셀 수 있다. 커버리지 계수기가 DB 가용성에 매이면 계수기를 못 믿게 된다.
 */
export async function collectContractBindings(root: string): Promise<ContractBinding[]> {
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.controller.ts'))
    // 계수기 자신을 시험하는 픽스처는 실제 계수에 섞지 않는다.
    .filter((name) => !name.split(/[\\/]/).some((segment) => segment.startsWith('__')))
    .sort();

  const bindings: ContractBinding[] = [];
  for (const file of files) {
    const absolute = join(root, file);
    const module = (await import(absolute)) as Record<string, unknown>;

    for (const exported of Object.values(module)) {
      if (!isConstructor(exported)) continue;
      const prototype = exported.prototype as Record<string, unknown>;

      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor') continue;

        // ⛔ prototype[name] 으로 읽으면 «getter 가 실행된다». 프로토타입에는 this 가
        // 없으므로 컨트롤러가 접근자 프로퍼티를 하나 가지는 순간 계수기가 통째로 죽는다.
        // 메서드 데코레이터의 메타데이터는 value 에 붙으므로 접근자는 볼 필요도 없다.
        const method = Object.getOwnPropertyDescriptor(prototype, name)?.value as unknown;
        if (typeof method !== 'function') continue;

        const key = Reflect.getMetadata(CONTRACT_OPERATION, method) as string | undefined;
        if (key) {
          bindings.push({
            key,
            handler: `${exported.name}.${name}`,
            source: relative(root, absolute),
          });
        }
      }
    }
  }
  return bindings;
}
