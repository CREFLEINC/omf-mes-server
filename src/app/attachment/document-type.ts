import { imageMimeOf } from '../../common/attachment-storage';

/** 사람이 눈으로 볼 수 있는 문서만 — 검사 결과·LOT 첨부(omf-all-around#58 · 장부 P-57 · 2026-10-16 내부 결정). */
export interface DocumentType {
  contentType: string;
  extension: string;
}

const OOXML: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const LEGACY_OFFICE: Readonly<Record<string, string>> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};
const TEXT: Readonly<Record<string, string>> = { csv: 'text/csv', txt: 'text/plain' };
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TEXT_PROBE = 8192;

const extensionOf = (fileName: string): string => fileName.split('.').pop()?.toLowerCase() ?? '';

/**
 * 파일의 «머리 바이트»로 종류를 정한다 — 확장자나 브라우저가 붙인 종류는 믿지 않는다(실행 파일 이름만 바꾼 것을 막는다).
 * ⚠ 오피스 문서는 머리(ZIP·OLE)만으로는 다른 압축과 가릴 수 없어 «확장자와 짝이 맞을 때만» 받는다. OOXML 은 안에
 *   `[Content_Types].xml` 이 있어야 한다. CSV·TXT 는 앞 8KB 에 NUL 이 없어야 한다(실행 파일은 대개 있다).
 * ⛔ 위에 없는 것은 전부 거절한다(허용 목록) — 실행 파일·스크립트·압축 파일.
 */
export function documentTypeOf(bytes: Buffer, fileName: string): DocumentType | undefined {
  const extension = extensionOf(fileName);
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf', extension: 'pdf' };
  const image = imageMimeOf(bytes);
  if (image !== undefined) return { contentType: image, extension: IMAGE_EXT[image] };
  if (bytes.subarray(0, 4).equals(ZIP) && OOXML[extension] !== undefined
    && bytes.includes(Buffer.from('[Content_Types].xml', 'latin1'))) {
    return { contentType: OOXML[extension], extension };
  }
  if (bytes.subarray(0, 8).equals(OLE) && LEGACY_OFFICE[extension] !== undefined) {
    return { contentType: LEGACY_OFFICE[extension], extension };
  }
  if (TEXT[extension] !== undefined && !bytes.subarray(0, TEXT_PROBE).includes(0)) {
    return { contentType: TEXT[extension], extension };
  }
  return undefined;
}
