import { Contract } from '../contract.decorator';

/** 계수기 자신을 시험하는 픽스처. `__` 로 시작하는 폴더라 실제 계수에서는 빠진다. */
export class ProbeController {
  @Contract('GET /app/permissions')
  bound(): string {
    return 'bound';
  }

  /** 계약에 없는 키. 유령 바인딩 검사가 이것을 잡아야 한다. */
  @Contract('GET /없는/경로')
  phantom(): string {
    return 'phantom';
  }

  unbound(): string {
    return 'unbound';
  }
}
