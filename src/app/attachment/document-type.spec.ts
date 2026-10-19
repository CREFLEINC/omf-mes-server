import { documentTypeOf } from './document-type';

/** omf-all-around#58 — 검사 문서는 사람이 볼 수 있는 것만(장부 P-57). */
describe('documentTypeOf', () => {
  const zip = (inner: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(inner, 'latin1')]);
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(16)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

  it('PDF·이미지·오피스·CSV 를 머리 바이트로 알아본다', () => {
    expect(documentTypeOf(Buffer.from('%PDF-1.7 ...'), '성적서.pdf')).toEqual({ contentType: 'application/pdf', extension: 'pdf' });
    expect(documentTypeOf(png, 'a.png')?.contentType).toBe('image/png');
    expect(documentTypeOf(zip('...[Content_Types].xml...'), '시험.xlsx')?.extension).toBe('xlsx');
    expect(documentTypeOf(ole, '옛날.xls')?.contentType).toBe('application/vnd.ms-excel');
    expect(documentTypeOf(Buffer.from('lot,qty\nA,1\n'), '측정.csv')?.contentType).toBe('text/csv');
  });

  it('실행 파일·이름만 바꾼 파일·일반 압축은 거절한다', () => {
    expect(documentTypeOf(Buffer.from('MZ\x90\x00\x03', 'latin1'), 'setup.exe')).toBeUndefined();
    expect(documentTypeOf(Buffer.from('MZ\x90\x00\x03', 'latin1'), '성적서.pdf')).toBeUndefined();
    expect(documentTypeOf(zip('plain zip'), 'a.xlsx')).toBeUndefined();
    expect(documentTypeOf(zip('...[Content_Types].xml...'), 'a.zip')).toBeUndefined();
    expect(documentTypeOf(Buffer.from('MZ\x00\x00', 'latin1'), 'a.csv')).toBeUndefined();
    expect(documentTypeOf(Buffer.from('#!/bin/sh\nrm -rf /'), 'run.sh')).toBeUndefined();
  });
});
