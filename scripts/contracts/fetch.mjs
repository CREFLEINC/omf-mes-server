/** 설계 저장소에서 계약을 읽어 온다. gh 의 로그인 자격증명을 쓴다 — 저장소가 비공개다. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { REPO, REMOTE_DIR } from './contracts.mjs';

const run = promisify(execFile);

// 계약 하나가 670KB 를 넘는다. execFile 기본 버퍼(1MB)로는 곧 모자라므로 넉넉히 잡는다.
const MAX_BUFFER = 32 * 1024 * 1024;

async function gh(args) {
  const { stdout } = await run('gh', args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

/** gh 가 없거나 로그인돼 있지 않으면 null — 「없음」을 「통과」로 바꾸지 않기 위해 구분한다. */
export async function ghAvailable() {
  try {
    await run('gh', ['auth', 'status'], { maxBuffer: MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
}

/** 인자가 없으면 설계 저장소 main 의 현재 커밋. */
export async function resolveRef(ref) {
  if (ref) return ref;
  const out = await gh(['api', `repos/${REPO}/commits/main`, '--jq', '.sha']);
  return out.trim();
}

export async function fetchContract(file, ref) {
  const encoded = encodeURIComponent(`${REMOTE_DIR}/${file}`).replace(/%2F/g, '/');
  const out = await gh([
    'api',
    `repos/${REPO}/contents/${encoded}?ref=${ref}`,
    '--jq',
    '.content',
  ]);
  return Buffer.from(out.replace(/\s/g, ''), 'base64').toString('utf8');
}
