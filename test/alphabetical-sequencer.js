/**
 * e2e 스위트를 **파일 이름 순**으로 돌린다.
 *
 * ⛔ jest 기본 정렬은 「지난 실행이 오래 걸린 것 먼저 · 없으면 파일 크기 큰 것 먼저」다.
 * 캐시(`.jest-cache`)와 파일 크기에 따라 **실행마다 순서가 바뀐다.** e2e 는 한 DB 를
 * 공유하고(`--runInBand`) 스위트가 서로의 흔적을 지우므로, 순서가 흔들리면 「어제는
 * 초록이고 오늘은 빨간」 결과가 재현 없이 나온다 — 실제로 하루에 세 번 겪었다(과제 #15).
 *
 * 순서를 고정한다고 스위트 사이의 얽힘이 사라지지는 않는다. **재현 가능해지는 것**이
 * 목적이다 — 얽힘이 있으면 «항상» 깨져서 고칠 수 있게 된다.
 */
const Sequencer = require('@jest/test-sequencer').default;

class AlphabeticalSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 실패한 것을 앞으로 당기는 기본 동작도 끈다 — 그것도 순서를 바꾼다. */
  cacheResults() {}
}

module.exports = AlphabeticalSequencer;
