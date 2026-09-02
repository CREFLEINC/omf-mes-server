/** 계약 `app-공통.json` `#/components/schemas/Session` 과 동형. */
export interface SessionScope {
  businessUnitId: number;
  plantId?: number;
}

export interface Session {
  userId: number;
  loginId: string;
  userName: string;
  departmentId?: number;
  /** 이번 로그인 «직전» 시각. 계약이 그렇게 정의했다. */
  lastLoginAt?: string;
  scopes: SessionScope[];
  roles: string[];
  permissions: string[];
}

/** 계약 `#/components/schemas/LoginFailure`. */
export interface LoginFailure {
  message: string;
  /** ⚠ 없는 계정에는 담지 않는다 — 그러면 계정 존재가 드러난다. */
  remainingAttempts?: number;
}
