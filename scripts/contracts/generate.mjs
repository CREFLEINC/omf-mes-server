#!/usr/bin/env node
/**
 * contracts/*.json → src/contracts/<slug>.d.ts
 *
 * 생성물은 커밋하지 않는다(.gitignore). Prisma Client 와 같은 취급이며 CI·Docker 가
 * 매번 다시 만든다. 계약 json 이 깨져 있으면 이 단계에서 걸린다 — 그것이 의도다.
 *
 * 한 파일이 실패해도 나머지를 마저 만들고, 끝에 실패 목록을 모아 보여준 뒤 죽는다.
 * 먼저 실패한 하나 때문에 나머지 여섯의 상태를 모르는 일이 없도록.
 */

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CONTRACTS, KNOWN_BROKEN, ROOT, localPath } from './contracts.mjs';

const run = promisify(execFile);
const outDir = join(ROOT, 'src', 'contracts');
mkdirSync(outDir, { recursive: true });

/** redocly 는 스택을 길게 뱉는다. 사람이 고칠 수 있는 한 줄만 남긴다. */
function reason(error) {
  const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`;
  const dup = text.match(/duplicated mapping key in "[^"]*"\s*\((\d+):(\d+)\)/);
  if (dup) {
    return `${dup[1]}행 — 같은 객체에 같은 키가 두 번 있다. JSON 파서는 뒤엣것만 남기므로 앞엣것이 조용히 사라진다`;
  }
  const first = text.split('\n').find((line) => /Error|error/.test(line));
  return (first ?? '알 수 없는 실패').trim().slice(0, 200);
}

const failed = [];
for (const { file, slug } of CONTRACTS) {
  const out = join(outDir, `${slug}.d.ts`);
  try {
    await run('pnpm', ['exec', 'openapi-typescript', localPath(file), '-o', out], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    console.log(`    ${file} → src/contracts/${slug}.d.ts`);
  } catch (error) {
    failed.push({ file, reason: reason(error) });
    console.log(`  ✗ ${file}`);
  }
}

if (failed.length === 0) process.exit(0);

// 이미 아는 상류 결함과 새로 생긴 실패를 가른다. 아는 것 때문에 빌드를 세우면
// 우리가 고칠 수 없는 것에 발이 묶이고, 뭉뚱그려 넘기면 새 결함이 조용히 묻힌다.
const known = new Map(KNOWN_BROKEN.map((entry) => [entry.file, entry]));
const unexpected = failed.filter(({ file }) => !known.has(file));

for (const { file, reason: why } of failed) {
  const entry = known.get(file);
  if (entry) {
    console.error(`\n⚠ ${file} — 알려진 상류 결함이라 넘어간다 (${entry.upstream})`);
    console.error(`    ${entry.reason}`);
    console.error(`    실측: ${why}`);
  } else {
    console.error(`\n✗ ${file}`);
    console.error(`    ${why}`);
  }
}

console.error('\ncontracts/ 는 설계 저장소의 읽기 전용 사본이라 여기서 고치지 않는다.');
console.error('설계 저장소(CREFLEINC/omf-mes)가 고치면 pnpm contracts:update 로 받는다.');

if (unexpected.length === 0) {
  console.error(`\n알려진 결함 ${failed.length}건뿐이다 — 그만큼 타입 검사가 비어 있다.`);
  process.exit(0);
}
console.error(`\n알려지지 않은 실패 ${unexpected.length}건 — 빌드를 세운다.`);
process.exit(1);
