#!/usr/bin/env node
/**
 * contracts/ 사본이 설계 저장소 현재본과 같은지 대조한다. 받아 쓰지는 않는다.
 *
 *   pnpm contracts:check          설계 저장소 main 과 대조
 *   pnpm contracts:check <sha>    특정 커밋과 대조
 *
 * 이슈 작업을 시작하기 전에 돌린다. 2026-08-10 부터 18일간 사본이 낡은 줄 아무도
 * 몰랐고, 그 사이 mdm 오퍼레이션이 46 → 103 으로 늘었다.
 *
 * 종료 코드 — 0 최신 · 1 어긋남 · 2 확인 불가(gh 없음).
 * 확인 불가를 0 으로 두지 않는다. 「검사하지 못함」과 「이상 없음」은 다르다.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { CONTRACTS, localPath, localCommit, operations } from './contracts.mjs';
import { ghAvailable, resolveRef, fetchContract } from './fetch.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

if (!(await ghAvailable())) {
  console.error('SKIP: gh 에 로그인돼 있지 않아 대조할 수 없다 (`gh auth login`).');
  process.exit(2);
}

const ref = await resolveRef(process.argv[2]);
const pinned = localCommit();
console.log(`사본 기준 ${pinned === 'unknown' ? 'unknown' : pinned.slice(0, 7)}  ↔  설계 ${ref.slice(0, 7)}\n`);

let drifted = 0;
for (const { file } of CONTRACTS) {
  let local;
  try {
    local = readFileSync(localPath(file), 'utf8');
  } catch {
    console.log(`  ✗ ${file} — 사본이 없다`);
    drifted += 1;
    continue;
  }

  const remote = await fetchContract(file, ref);
  if (sha(local) === sha(remote)) {
    console.log(`    ${file} — 최신`);
    continue;
  }

  drifted += 1;
  const localOps = operations(JSON.parse(local));
  const remoteOps = operations(JSON.parse(remote));
  const added = remoteOps.filter((o) => !localOps.includes(o));
  const removed = localOps.filter((o) => !remoteOps.includes(o));
  console.log(`  ✗ ${file} — 오퍼레이션 ${localOps.length} → ${remoteOps.length}`);
  for (const op of added.slice(0, 20)) console.log(`      + ${op}`);
  if (added.length > 20) console.log(`      … 추가 ${added.length - 20}건 더`);
  for (const op of removed.slice(0, 20)) console.log(`      - ${op}`);
  if (removed.length > 20) console.log(`      … 삭제 ${removed.length - 20}건 더`);
  if (!added.length && !removed.length) {
    console.log('      경로는 같고 내용만 달라졌다(필드·설명·예시)');
  }
}

if (drifted === 0) {
  console.log('\n사본이 설계 저장소와 같다.');
  process.exit(0);
}
console.log(`\n${drifted}개 파일이 어긋난다. pnpm contracts:update 로 받아온 뒤 diff 를 확인한다.`);
process.exit(1);
