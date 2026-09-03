#!/usr/bin/env node
/**
 * 워크플로 V3(`multi-agent-team-workflow-v3.md`) 로컬 상태를 갱신한다.
 *
 *   pnpm workflow:bootstrap        .backend-dev/state.json 스냅샷 갱신
 *   pnpm workflow:sync-design      .design-reference/omf-mes 를 최신 main 으로 새로고침
 *
 * state.json 은 로컬 전용(.gitignore) — 담당 팀 / 적용한 워크플로 버전 / 설계 고정 커밋
 * (contracts/COMMIT.txt 값) / 설계 변경 회차(변경-요약.md)를 담는다. 상세: docs/agents/team-protocol.md.
 *
 * 종료 코드 — 0 성공 · 1 실패(정본 문서·설계 참고 클론 없음 등).
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DOC = join(ROOT, 'multi-agent-team-workflow-v3.md');
const STATE_DIR = join(ROOT, '.backend-dev');
const STATE_FILE = join(STATE_DIR, 'state.json');
const COMMIT_FILE = join(ROOT, 'contracts', 'COMMIT.txt');
const DESIGN_REF = join(ROOT, '.design-reference', 'omf-mes');
const DESIGN_REPO = 'git@github.com:CREFLEINC/omf-mes.git';
// 규칙 5(설계 자료 고정)의 실제 전달 수단 — 설계팀은 개별 이슈를 이 저장소에 열지 않고,
// git 이력에서 만든 이 표로 "무엇이 언제 바뀌었나"만 전한다(2026-09-03 방침 개정).
const CHANGE_LOG = join(DESIGN_REF, 'design', 'wiki', 'handover', '변경-요약.md');

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function readChangeRound() {
  if (!existsSync(CHANGE_LOG)) return null;
  const match = readFileSync(CHANGE_LOG, 'utf8').match(/변경 회차\s*\|\s*\*\*(\d+)\*\*/);
  return match ? Number(match[1]) : null;
}

function bootstrap() {
  if (!existsSync(WORKFLOW_DOC)) {
    console.error(`SKIP: ${WORKFLOW_DOC} 가 없다 — 정본 문서를 먼저 두어야 한다.`);
    process.exit(1);
  }
  const docHash = sha(readFileSync(WORKFLOW_DOC, 'utf8'));
  const designFixedCommit = existsSync(COMMIT_FILE)
    ? readFileSync(COMMIT_FILE, 'utf8').trim()
    : null;
  const prev = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
  const designChangeRound = readChangeRound();

  mkdirSync(STATE_DIR, { recursive: true });
  const state = {
    team: '백엔드 개발팀',
    repo: 'CREFLEINC/omf-mes-server',
    workflowVersion: 'v3',
    workflowDocHash: docHash,
    designFixedCommit,
    designFixedCommitSource: 'contracts/COMMIT.txt',
    designChangeRound,
    designChangeLogSource: 'design/wiki/handover/변경-요약.md (pnpm workflow:sync-design 으로 새로고침)',
    bootstrappedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log(`OK  ${STATE_FILE}`);
  console.log(JSON.stringify(state, null, 2));

  if (designChangeRound === null) {
    console.log(
      '\n(설계 참고 클론이 없거나 변경-요약.md 를 못 찾아 변경 회차를 확인하지 못했다 — 먼저 `pnpm workflow:sync-design`)',
    );
  } else if (prev?.designChangeRound != null && prev.designChangeRound !== designChangeRound) {
    console.log(
      `\n⚠ 설계 변경 회차 ${prev.designChangeRound} → ${designChangeRound} — ` +
        '.design-reference/omf-mes/design/wiki/handover/변경-요약.md 를 확인하고 규칙 5(설계 자료 고정)를 따른다.',
    );
  }
}

function syncDesignReference() {
  if (!existsSync(DESIGN_REF)) {
    console.error(
      `SKIP: ${DESIGN_REF} 가 없다 — 처음 설정은 다음으로 클론한다(V2 §2.2, 워크트리 임시 폴더):\n` +
        `  git clone ${DESIGN_REPO} ${DESIGN_REF}`,
    );
    process.exit(1);
  }
  execSync('git fetch origin', { cwd: DESIGN_REF, stdio: 'inherit' });
  execSync('git checkout main', { cwd: DESIGN_REF, stdio: 'inherit' });
  execSync('git pull --ff-only origin main', { cwd: DESIGN_REF, stdio: 'inherit' });
  console.log(`OK  ${DESIGN_REF} → main 최신`);
}

const arg = process.argv[2];
if (arg === '--sync-design') {
  syncDesignReference();
} else if (arg === undefined) {
  bootstrap();
} else {
  console.error(`알 수 없는 옵션: ${arg}`);
  process.exit(1);
}
