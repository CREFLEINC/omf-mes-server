export function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}
