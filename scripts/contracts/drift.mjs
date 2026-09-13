#!/usr/bin/env node
/**
 * contracts/ 사본이 **고정 커밋 그대로인가**를 본다. 즉 「우리가 사본을 고쳤나」다.
 *
 *   pnpm contracts:drift
 *
 * ⛔ `contracts:check` 와 «다른 질문»이다.
 *
 *   check  사본 ↔ 설계 **최신**   → 「설계가 움직였나」
 *   drift  사본 ↔ 설계 **고정**   → 「우리가 고쳤나」
 *
 * 둘을 가릴 수단이 없어서 사고가 났다 — #610 이 클라이언트 전달본 «생성기 출력»을
 * `logistics-01자재창고.json` 에 덮어썼는데, `check` 는 그것을 「설계가 움직였다」와
 * 똑같은 빨간불로 보여 18일 넘게 아무도 못 봤다. 사본에 든 것이 정본에 없으면 다음
 * `contracts:update` 가 **조용히 지운다** — 서버가 그 칸에 기대고 있으면 그때 깨진다.
 *
 * 어긋난 것을 발견하면 지우기 전에 `docs/계약-선행-수정항목.md` 에 항목을 연다.
 *
 * 종료 코드 — 0 사본이 고정 커밋과 같다 · 1 어긋남 · 2 확인 불가(gh 없음).
 */

import { readFileSync } from 'node:fs';

import { CONTRACTS, localPath, localCommit } from './contracts.mjs';
import { ghAvailable, fetchContract } from './fetch.mjs';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * 키 순서를 맞춘 뒤 비교한다. 재직렬화만으로 「달라졌다」가 나오면 진짜 편집이 묻힌다 —
 * 실제로 #610 은 파일을 통째로 다시 쓴 탓에 텍스트 diff 가 3만 줄이었다.
 */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k])]));
  }
  return value;
}
const stable = (value) => JSON.stringify(normalize(value));

function operationMap(document) {
  const result = {};
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (METHODS.has(method)) result[`${method.toUpperCase()} ${path}`] = operation;
    }
  }
  return result;
}

/** 사본에만 있는 것 · 정본에만 있는 것 · 양쪽에 있으나 다른 것. */
function compare(pinned, local) {
  return {
    added: Object.keys(local).filter((k) => !(k in pinned)),
    removed: Object.keys(pinned).filter((k) => !(k in local)),
    changed: Object.keys(local).filter((k) => k in pinned && stable(pinned[k]) !== stable(local[k])),
  };
}

function report(label, diff, limit = 12) {
  const lines = [
    ...diff.added.map((k) => `      + ${label} ${k}   (사본에만 있다)`),
    ...diff.removed.map((k) => `      - ${label} ${k}   (정본에만 있다)`),
    ...diff.changed.map((k) => `      ~ ${label} ${k}`),
  ];
  for (const line of lines.slice(0, limit)) console.log(line);
  if (lines.length > limit) console.log(`      … ${label} ${lines.length - limit}건 더`);
  return lines.length;
}

if (!(await ghAvailable())) {
  console.error('SKIP: gh 에 로그인돼 있지 않아 대조할 수 없다 (`gh auth login`).');
  process.exit(2);
}

const pinnedRef = localCommit();
if (pinnedRef === 'unknown') {
  console.error('contracts/COMMIT.txt 에 고정 커밋이 없다. 무엇과 대조할지 알 수 없다.');
  process.exit(2);
}

console.log(`사본 ↔ 고정 커밋 ${pinnedRef.slice(0, 7)}\n`);

let drifted = 0;
let total = 0;
for (const { file } of CONTRACTS) {
  const local = JSON.parse(readFileSync(localPath(file), 'utf8'));
  const pinned = JSON.parse(await fetchContract(file, pinnedRef));

  const ops = compare(operationMap(pinned), operationMap(local));
  const schemas = compare(pinned.components?.schemas ?? {}, local.components?.schemas ?? {});
  const count =
    ops.added.length + ops.removed.length + ops.changed.length +
    schemas.added.length + schemas.removed.length + schemas.changed.length;

  if (count === 0) {
    console.log(`    ${file} — 고정 커밋 그대로`);
    continue;
  }
  drifted += 1;
  total += count;
  console.log(`  ✗ ${file} — ${count}건 어긋난다`);
  report('오퍼레이션', ops);
  report('스키마', schemas);
}

if (drifted === 0) {
  console.log('\n사본이 고정 커밋 그대로다.');
  process.exit(0);
}
console.log(`\n${drifted}개 파일 · ${total}건이 고정 커밋과 다르다.`);
console.log('⛔ 사본은 읽기 전용이다. 서버가 계약보다 앞서 나간 자리는');
console.log('   `contracts/` 가 아니라 `docs/계약-선행-수정항목.md` 에 적는다 —');
console.log('   사본에 적으면 다음 `contracts:update` 가 조용히 지운다.');
process.exit(1);
