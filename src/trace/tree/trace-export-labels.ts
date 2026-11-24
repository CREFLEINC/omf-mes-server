/**
 * 엑셀 내보내기 문구(피처 015) — 화면(`packages/i18n` trace-tree 슬라이스)과 같은 말을 쓴다. 언어는 요청 본문 `language`(ko·vi).
 * LOT 상태는 여기 두지 않고 공통코드 이름(`code_value.name_ko`·`name_vi`)으로 푼다.
 */
export type ExportLanguage = 'ko' | 'vi';

export type LineageStage =
  | 'MATERIAL_LOT' | 'SPLIT_LOT' | 'SEPARATED_LOT' | 'SPLIT_ORIGIN' | 'SEPARATED_ORIGIN' | 'WORK_ORDER' | 'PRODUCTION_LOT' | 'SEMI_LOT'
  | 'PACKAGE' | 'SHIPMENT' | 'STOCK' | 'SERIAL' | 'COMPONENT_SERIAL' | 'INBOUND_LOT';

interface Labels {
  sheets: { end: string; lineage: string };
  forwardHead: string[];
  backwardHead: string[];
  lineageHead: string[];
  stages: Record<LineageStage, string>;
  basis: Record<string, string>;
  fates: Record<string, string>;
  duplicate: string;
  cycle: string;
  partial: string;
}

const KO: Labels = {
  sheets: { end: '최종 LOT', lineage: 'LOT 계보' },
  forwardHead: ['기준 LOT', '제품 LOT', '품목 코드', '품목명', '생산 수량', '단위', '현황', '고객', '출하번호', '출하일', '출하 수량', '창고', '위치', '재고 수량', 'W/O', 'LOT 상태', '비고'],
  backwardHead: ['기준 LOT', '자재 LOT', '품목 코드', '품목명', '공급사', '공급사 LOT', '입하 LOT', '입하일', 'IQC', 'W/O', '생산 LOT', '투입량', '단위', '연결 근거', 'LOT 상태', '비고'],
  lineageHead: ['기준 LOT', '깊이', '단계', '번호', '품목 코드', '품목명', '수량', '단위', '상위 항목', '연결 근거', 'LOT 상태', '비고'],
  stages: {
    MATERIAL_LOT: '자재 LOT', SPLIT_LOT: '분할 LOT', SEPARATED_LOT: '분리 LOT', SPLIT_ORIGIN: '분할된 원래 LOT', SEPARATED_ORIGIN: '분리된 원래 LOT',
    WORK_ORDER: 'W/O', PRODUCTION_LOT: '생산 LOT', SEMI_LOT: '반제품 LOT', PACKAGE: '포장', SHIPMENT: '출하', STOCK: '재고', SERIAL: '시리얼',
    COMPONENT_SERIAL: '부품 시리얼', INBOUND_LOT: '입하 LOT',
  },
  basis: { RECORDED: '기록', LOT_GENEALOGY_ESTIMATE: '추정(계보)', WORK_ORDER_ESTIMATE: '추정(W/O 단위)' },
  fates: { SHIPPED: '출하', IN_STOCK: '재고', PARTIAL: '일부 출하', CONSUMED_OUT: '소진', VOIDED: '폐기' },
  duplicate: '중복 — 위와 같음',
  cycle: '순환 참조 — 전개 중단',
  partial: '일부',
};

const VI: Labels = {
  sheets: { end: 'LOT cuối', lineage: 'Phả hệ LOT' },
  forwardHead: ['LOT gốc tra cứu', 'LOT thành phẩm', 'Mã mặt hàng', 'Tên mặt hàng', 'SL sản xuất', 'Đơn vị', 'Hiện trạng', 'Khách hàng', 'Số xuất hàng',
    'Ngày xuất', 'SL xuất', 'Kho', 'Vị trí', 'SL tồn', 'W/O', 'Trạng thái LOT', 'Ghi chú'],
  backwardHead: ['LOT gốc tra cứu', 'LOT vật tư', 'Mã mặt hàng', 'Tên mặt hàng', 'Nhà cung cấp', 'LOT nhà cung cấp', 'LOT nhập hàng', 'Ngày nhập',
    'IQC', 'W/O', 'LOT sản xuất', 'SL đưa vào', 'Đơn vị', 'Căn cứ liên kết', 'Trạng thái LOT', 'Ghi chú'],
  lineageHead: ['LOT gốc tra cứu', 'Cấp', 'Công đoạn', 'Số', 'Mã mặt hàng', 'Tên mặt hàng', 'Số lượng', 'Đơn vị', 'Mục cấp trên', 'Căn cứ liên kết',
    'Trạng thái LOT', 'Ghi chú'],
  stages: {
    MATERIAL_LOT: 'LOT vật tư', SPLIT_LOT: 'LOT tách', SEPARATED_LOT: 'LOT chia', SPLIT_ORIGIN: 'LOT gốc đã tách', SEPARATED_ORIGIN: 'LOT gốc đã chia',
    WORK_ORDER: 'W/O', PRODUCTION_LOT: 'LOT sản xuất', SEMI_LOT: 'LOT bán thành phẩm', PACKAGE: 'Đóng gói', SHIPMENT: 'Xuất hàng', STOCK: 'Tồn kho',
    SERIAL: 'Sê-ri', COMPONENT_SERIAL: 'Sê-ri linh kiện', INBOUND_LOT: 'LOT nhập hàng',
  },
  basis: { RECORDED: 'Ghi nhận', LOT_GENEALOGY_ESTIMATE: 'Ước tính (phả hệ)', WORK_ORDER_ESTIMATE: 'Ước tính (theo W/O)' },
  fates: { SHIPPED: 'Xuất hàng', IN_STOCK: 'Tồn kho', PARTIAL: 'Xuất một phần', CONSUMED_OUT: 'Đã dùng hết', VOIDED: 'Hủy bỏ' },
  duplicate: 'Trùng — giống phía trên',
  cycle: 'Tham chiếu vòng — dừng mở rộng',
  partial: 'Một phần',
};

export const exportLabels = (language: ExportLanguage): Labels => (language === 'vi' ? VI : KO);

/** 본문 `language` 가 없으면 Accept-Language 첫 언어가 vi 일 때만 vi, 아니면 ko. */
export function exportLanguage(body: string | undefined, acceptLanguage: string | undefined): ExportLanguage {
  if (body === 'ko' || body === 'vi') return body;
  return (acceptLanguage ?? '').trim().toLowerCase().startsWith('vi') ? 'vi' : 'ko';
}

/** 창고·위치 — 이름(코드). */
export const named = (place: { code: string; name: string }): string => `${place.name} (${place.code})`;
