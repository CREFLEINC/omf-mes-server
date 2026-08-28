/**
 * 계약 사본의 단일 정의.
 *
 * 정본은 설계 저장소 CREFLEINC/omf-mes 이고, contracts/ 는 그 읽기 전용 사본이다.
 * 사본을 커밋하는 이유는 둘이다 — CI·Docker 가 계약 없이는 타입을 만들 수 없고,
 * 같은 커밋이 언제 빌드하든 같은 계약으로 빌드돼야 한다.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const REPO = 'CREFLEINC/omf-mes';
export const REMOTE_DIR = 'design/wiki/api-contracts/openapi';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTRACTS_DIR = join(ROOT, 'contracts');
export const COMMIT_FILE = join(CONTRACTS_DIR, 'COMMIT.txt');

/**
 * 파일명은 설계 저장소를 그대로 따르고, 생성 타입 이름만 ASCII 로 줄인다.
 * `slug` 는 src/contracts/<slug>.d.ts 가 된다 — import 경로에 한글이 섞이지 않게.
 */
export const CONTRACTS = [
  { file: 'app-공통.json', slug: 'app' },
  { file: 'equipment-05설비툴.json', slug: 'equipment' },
  { file: 'logistics-01자재창고.json', slug: 'logistics' },
  { file: 'mdm-기준정보.json', slug: 'mdm' },
  { file: 'production-02생산실행.json', slug: 'production' },
  { file: 'quality-03품질.json', slug: 'quality' },
  { file: 'shipment-04제품출하.json', slug: 'shipment' },
];

/**
 * 정본이 깨져 있어 타입을 만들 수 없는 계약. **사본은 읽기 전용이라 여기서 못 고친다.**
 *
 * 빈 목록이 정상이다. 여기 무언가 있으면 그만큼 타입 검사가 비어 있다는 뜻이므로,
 * 설계 저장소가 고치는 대로 지운다. 목록에 없는 새 실패는 그대로 빌드를 세운다.
 */
export const KNOWN_BROKEN = [
  {
    file: 'logistics-01자재창고.json',
    reason:
      'InboundReceiptCreate 에 x-internal-note 키가 두 번 있다(8501행·8598행). ' +
      'JSON 파서가 뒤엣것만 남겨 앞의 OCR 결손 메모가 사라지고, openapi-typescript 는 파싱에서 실패한다',
    upstream: '이슈 #49 · 설계 저장소 CREFLEINC/omf-mes',
  },
];

export function localPath(file) {
  return join(CONTRACTS_DIR, file);
}

/** 사본이 어느 설계 커밋에서 왔는지. 없으면 unknown — 지어내지 않는다. */
export function localCommit() {
  if (!existsSync(COMMIT_FILE)) return 'unknown';
  const text = readFileSync(COMMIT_FILE, 'utf8').trim();
  return text.replace(/^REV=/, '').trim() || 'unknown';
}

/** 오퍼레이션 수 — 드리프트를 사람이 읽을 수 있는 크기로 요약할 때 쓴다. */
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function operations(document) {
  const result = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (METHODS.has(method)) result.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return result.sort();
}
