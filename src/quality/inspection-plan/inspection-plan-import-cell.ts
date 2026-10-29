/** 엑셀 셀은 수식·서식 객체로도 온다 — 사람이 보는 글자만 뽑는다. */
export function cellText(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  // ⛔ 고객사 기준서에는 깨진 날짜 셀이 있다 — `toISOString` 이 던지면 파일 전체가 500 이 된다.
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  if (typeof cell === 'object' && 'result' in cell) return cellText((cell as { result: unknown }).result);
  if (typeof cell === 'object' && 'text' in cell) return cellText((cell as { text: unknown }).text);
  if (typeof cell === 'object' && 'richText' in cell) {
    return cellText((cell as { richText: { text: string }[] }).richText.map((part) => part.text).join(''));
  }
  const value = String(cell).trim();
  return value === '' ? null : value;
}
