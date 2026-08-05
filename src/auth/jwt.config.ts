const MIN_SECRET_LENGTH = 32;
const DEFAULT_EXPIRES_IN_SECONDS = 28_800;

/** 클래스로 두는 것은 DI 토큰으로 쓰기 위해서다 — 타입만으로는 주입할 수 없다. */
export class JwtConfig {
  constructor(
    readonly secret: string,
    readonly expiresInSeconds: number,
  ) {}
}

/**
 * 기본값을 두지 않는다. 두면 약한 키로 조용히 운영에 올라가고, 그 사실을 아무도 모른다.
 * 없거나 짧으면 기동 자체를 실패시킨다.
 */
export function readJwtConfig(env: NodeJS.ProcessEnv): JwtConfig {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET 이 없거나 ${MIN_SECRET_LENGTH}자 미만입니다. openssl rand -base64 48 로 만드십시오.`,
    );
  }

  // 환경변수는 문자열로 온다. jsonwebtoken 의 expiresIn 은 문자열을 ms() 로 해석해
  // '28800' 을 28.8초로 읽는다 — 반드시 숫자로 넘긴다.
  const parsed = Number(env.JWT_EXPIRES_IN_SECONDS);
  const expiresInSeconds =
    Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_EXPIRES_IN_SECONDS;

  return new JwtConfig(secret, expiresInSeconds);
}
