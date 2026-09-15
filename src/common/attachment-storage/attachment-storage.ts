import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

/**
 * 첨부 파일 한 장의 상한 — 창고 도면·공지 첨부·고장 사진이 함께 쓴다.
 * ⚠ proxy 의 `client_max_body_size`(deploy/proxy/omf-api.conf)보다 작아야 앱이 JSON 413 을 낸다.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** multer 2 는 multipart 파일 이름을 latin1 로 풀어 한글 이름이 깨진다 — UTF-8 로 읽게 한다. */
export const ATTACHMENT_UPLOAD_OPTIONS = { limits: { fileSize: MAX_ATTACHMENT_BYTES }, defParamCharset: 'utf8' };

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** 운영은 compose 가 컨테이너 안 경로로 고정한다. 없으면 첨부만 503 이고 부팅은 막지 않는다. */
export function attachmentRoot(): string {
  const root = process.env.ATTACHMENT_STORAGE_ROOT;
  if (!root || !isAbsolute(root)) throw new ServiceUnavailableException('첨부 저장 경로가 설정되지 않았습니다.');
  return root;
}

/** 내려받기 헤더에 그대로 실리므로 경로 구분자·제어 문자를 받지 않는다. 맞지 않으면 undefined. */
export function attachmentFileName(raw: string): string | undefined {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0 || name.length > 255) return undefined;
  const unsafe = [...name].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f || char === '/' || char === '\\';
  });
  return unsafe ? undefined : name;
}

/** 요청의 Content-Type 은 믿지 않는다 — 앞 바이트로 가린다. */
export function imageMimeOf(bytes: Buffer): ImageMime | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

/**
 * 파일을 먼저 쓰고 `commit`(DB 행)을 부른다. 행이 파일보다 늦게 서므로, 행이 있으면 파일도 있다 —
 * 블루-그린으로 두 api 가 같은 볼륨을 봐도 반쯤 쓴 파일을 읽지 않는다.
 * 키는 uuid 에 새 파일(`wx`)로만 쓰고, 재생이거나 커밋이 실패하면 방금 쓴 파일을 지운다.
 */
export async function storeAttachment<T>(
  root: string,
  file: { area: string; extension: string; bytes: Buffer },
  commit: (storageKey: string) => Promise<{ replayed: boolean; body: T }>,
): Promise<T> {
  const now = new Date();
  const directory = posix.join(file.area, String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'));
  const storageKey = posix.join(directory, `${randomUUID()}.${file.extension}`);
  const absolute = join(root, storageKey);
  await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  await writeFile(absolute, file.bytes, { flag: 'wx', mode: 0o600 });
  try {
    const outcome = await commit(storageKey);
    if (outcome.replayed) await unlink(absolute).catch(() => undefined);
    return outcome.body;
  } catch (error) {
    await unlink(absolute).catch(() => undefined);
    throw error;
  }
}

/**
 * 저장 키로 파일을 읽는다. 키가 루트 밖을 가리키거나(`..`·절대 경로·NUL) 파일이 없으면 undefined —
 * 404 판정은 부르는 쪽이 한다. 키는 서버가 만들지만 DB 값이라 경로 이탈을 한 번 더 막는다.
 */
export async function readAttachment(root: string, storageKey: string): Promise<Buffer | undefined> {
  if (storageKey.length === 0 || storageKey.includes('\0') || isAbsolute(storageKey)) return undefined;
  const base = resolve(root);
  const within = relative(base, resolve(base, storageKey));
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
  try {
    return await readFile(join(base, within));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}
