#!/usr/bin/env node
/**
 * 설계 저장소의 계약을 contracts/ 로 받아온다.
 *
 *   pnpm contracts:update          설계 저장소 main 의 현재 커밋
 *   pnpm contracts:update <sha>    특정 커밋으로 고정
 *
 * 받은 뒤 `git diff contracts/` 가 곧 계약 변경 알림이다. 정본은 버전을 올리지 않고
 * 바뀌므로(info.version 이 0.1.0 인 채로 오퍼레이션이 늘어난다) diff 말고는 알 길이 없다.
 */

import { writeFileSync } from 'node:fs';

import { CONTRACTS, COMMIT_FILE, localPath, localCommit, operations } from './contracts.mjs';
import { ghAvailable, resolveRef, fetchContract } from './fetch.mjs';

if (!(await ghAvailable())) {
  console.error('gh 에 로그인돼 있지 않다. `gh auth login` 후 다시 실행한다.');
  console.error('설계 저장소가 비공개라 읽기 권한이 있는 계정이어야 한다.');
  process.exit(2);
}

const before = localCommit();
const ref = await resolveRef(process.argv[2]);
console.log(`설계 커밋 ${ref.slice(0, 7)}${process.argv[2] ? ' (지정)' : ' (main 최신)'}`);
if (before !== 'unknown') console.log(`현재 사본  ${before.slice(0, 7)}`);
console.log();

let changed = 0;
for (const { file } of CONTRACTS) {
  const remote = await fetchContract(file, ref);
  let previous = null;
  try {
    previous = JSON.parse((await import('node:fs')).readFileSync(localPath(file), 'utf8'));
  } catch {
    /* 처음 받는 파일 */
  }
  writeFileSync(localPath(file), remote, 'utf8');

  const after = operations(JSON.parse(remote));
  if (!previous) {
    console.log(`  + ${file} — 신규, 오퍼레이션 ${after.length}`);
    changed += 1;
    continue;
  }
  const beforeOps = operations(previous);
  const added = after.filter((o) => !beforeOps.includes(o));
  const removed = beforeOps.filter((o) => !after.includes(o));
  if (!added.length && !removed.length) {
    console.log(`    ${file} — 그대로 (${after.length})`);
    continue;
  }
  changed += 1;
  console.log(`  ~ ${file} — ${beforeOps.length} → ${after.length}`);
  for (const op of added) console.log(`      + ${op}`);
  for (const op of removed) console.log(`      - ${op}`);
}

writeFileSync(COMMIT_FILE, `${ref}\n`, 'utf8');
console.log(`\n${changed}개 파일이 바뀌었다. contracts/COMMIT.txt = ${ref.slice(0, 7)}`);
console.log('다음: git diff contracts/ 로 변경을 확인하고, pnpm contracts:generate 로 타입을 다시 만든다.');
