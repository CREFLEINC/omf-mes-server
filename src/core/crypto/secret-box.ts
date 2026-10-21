import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * 비밀값 대칭 암호화 — AES-256-GCM, 저장 형식 `v1:iv:tag:ct`(각 base64 · research R-9).
 * Zalo 갱신 토큰이 회전해 DB 에 둘 수밖에 없고, 원문 저장은 FR-028 위반이라 둔다.
 * ⛔ 원문·키를 오류 문구에 싣지 않는다.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`암호화 키는 ${KEY_BYTES}바이트 base64 여야 한다`);
    this.key = key;
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), ct].map((part) => (typeof part === 'string' ? part : part.toString('base64'))).join(':');
  }

  /**
   * 키를 쓴 HMAC-SHA256 — 같은 값이면 같은 결과라 멱등 지문에 넣을 수 있고, 키 없이는 대조할 수 없다.
   * 평문 해시를 남기면 DB 덤프만으로 짧은 비밀값을 맞춰 볼 수 있다.
   */
  digest(plain: string): string {
    return createHmac('sha256', this.key).update(plain).digest('base64');
  }

  /** 키가 다르거나 변조됐으면 던진다(GCM 태그 검증). */
  open(sealed: string): string {
    const [version, iv, tag, ct] = sealed.split(':');
    if (version !== VERSION || iv === undefined || tag === undefined || ct === undefined) {
      throw new Error('알 수 없는 암호문 형식이다');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }
}
