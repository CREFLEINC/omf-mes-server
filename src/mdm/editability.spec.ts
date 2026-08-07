import { toEditability } from './editability';

describe('toEditability', () => {
  it('참조가 없으면 코드를 고칠 수 있다', () => {
    expect(toEditability(0)).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('한 건이라도 참조되면 잠근다 — 과거 전표가 무엇을 가리키는지 어긋난다', () => {
    expect(toEditability(1)).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('건수를 그대로 담는다 — 화면이 세지 않는다(공유계약 B-4)', () => {
    expect(toEditability(350)).toMatchObject({ referenceCount: 350 });
  });
});
