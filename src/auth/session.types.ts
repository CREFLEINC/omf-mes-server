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
  /**
   * 임시 비밀번호로 들어왔는가. 화면은 이 값이 `true` 면 비밀번호 변경으로 보낸다.
   * ⛔ 불리언은 늘 아는 값이라 «언제나» 싣는다 — 부재를 「모른다」로 읽을 자리를 만들지 않는다.
   */
  mustChangePassword: boolean;
  /**
   * 이 계정에 연결된 작업자(omf-all-around#104 · 장부 P-38). 없으면 `null` — 부재를 「모른다」로
   * 읽지 않도록 «언제나» 싣는다(P-2 와 같은 규율). 관리웹 IQC 판정은 이 값이 없으면 저장 전에 안내한다.
   */
  worker: { workerId: number; workerNo: string; workerName: string } | null;
}

/** 계약 `#/components/schemas/LoginFailure`. */
export interface LoginFailure {
  message: string;
  /** ⚠ 없는 계정에는 담지 않는다 — 그러면 계정 존재가 드러난다. */
  remainingAttempts?: number;
}
