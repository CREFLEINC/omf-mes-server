import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'src');

/** `import { X } from 'pkg'` — 값 import. `import type` 은 지운다. */
const VALUE_IMPORT = /^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gm;

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => join(SRC, name));
}

describe('런타임 의존성', () => {
  const declared = (() => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.dependencies ?? {}));
  })();

  it('⛔ 값으로 import 하는 패키지는 전부 dependencies 에 있다', () => {
    // 운영 이미지는 prod-deps 의 node_modules 만 담고 pnpm 은 호이스팅하지 않는다.
    // 선언하지 않은 패키지를 값으로 부르면 «부팅에서» 죽는데, dev 에서는 devDependency 나
    // 전이 의존성으로 우연히 풀려 안 드러난다 — 실제로 express 가 그랬다(#98).
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(VALUE_IMPORT)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        // `@scope/pkg/sub` · `pkg/sub` 에서 패키지 이름만 뗀다.
        const parts = specifier.split('/');
        const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!declared.has(name)) offenders.push(`${file.slice(ROOT.length + 1)} → ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('검사가 헛통과가 아니다 — 선언 안 된 이름을 실제로 잡는다', () => {
    const specifier = 'express';

    expect(declared.has(specifier)).toBe(false);
    // 값 import 였다면 걸렸을 이름이다. 지금은 전부 `import type` 이라 위 검사가 통과한다.
    expect(/^import\s+type\s/m.test(readFileSync(join(SRC, 'auth/session-cookie.ts'), 'utf8'))).toBe(
      true,
    );
  });
});
