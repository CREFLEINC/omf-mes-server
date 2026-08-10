import {
  business_unit,
  equipment,
  legal_entity,
  plant,
  process,
  production_line,
  partner,
  uom,
} from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { toDateOnly } from '../date-only';

type Schemas = components['schemas'];

/** 반환 타입이 계약에서 나오므로 필드를 빠뜨리거나 이름을 틀리면 컴파일이 실패한다. */
export function toUom(row: uom): Schemas['Uom'] {
  return {
    uomId: Number(row.uom_id),
    uomCode: row.uom_code,
    uomName: row.uom_name,
    decimalScale: row.decimal_scale,
    isActive: row.is_active,
  };
}

export function toPartner(row: partner): Schemas['Partner'] {
  return {
    partnerId: Number(row.partner_id),
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    countryCode: row.country_code,
    erpPartnerCode: row.erp_partner_code,
    isActive: row.is_active,
  };
}

export function toLegalEntity(row: legal_entity): Schemas['LegalEntity'] {
  return {
    legalEntityId: Number(row.legal_entity_id),
    legalEntityCode: row.legal_entity_code,
    legalEntityName: row.legal_entity_name,
    countryCode: row.country_code,
    timezoneCode: row.timezone_code,
    isActive: row.is_active,
  };
}

export function toBusinessUnit(row: business_unit): Schemas['BusinessUnit'] {
  return {
    businessUnitId: Number(row.business_unit_id),
    legalEntityId: Number(row.legal_entity_id),
    businessUnitCode: row.business_unit_code,
    businessUnitName: row.business_unit_name,
    isActive: row.is_active,
  };
}

export function toPlant(row: plant): Schemas['Plant'] {
  return {
    plantId: Number(row.plant_id),
    legalEntityId: Number(row.legal_entity_id),
    businessUnitId: row.business_unit_id === null ? null : Number(row.business_unit_id),
    plantCode: row.plant_code,
    plantName: row.plant_name,
    timezoneCode: row.timezone_code,
    isActive: row.is_active,
  };
}

export function toProductionLine(row: production_line): Schemas['ProductionLine'] {
  return {
    productionLineId: Number(row.production_line_id),
    plantId: Number(row.plant_id),
    parentLineId: row.parent_line_id === null ? null : Number(row.parent_line_id),
    lineCode: row.line_code,
    lineName: row.line_name,
    lineTypeCode: row.line_type_code,
    isActive: row.is_active,
  };
}

export function toProcess(row: process): Schemas['Process'] {
  return {
    processId: Number(row.process_id),
    processCode: row.process_code,
    processName: row.process_name,
    processTypeCode: row.process_type_code,
    isActive: row.is_active,
  };
}

export function toEquipment(row: equipment): Schemas['Equipment'] {
  return {
    equipmentId: Number(row.equipment_id),
    plantId: Number(row.plant_id),
    equipmentCode: row.equipment_code,
    equipmentName: row.equipment_name,
    equipmentTypeCode: row.equipment_type_code,
    processId: row.process_id === null ? null : Number(row.process_id),
    productionLineId: row.production_line_id === null ? null : Number(row.production_line_id),
    statusCode: row.status_code,
    calibrationRequired: row.calibration_required,
    // @db.Date 다 — 타임존을 태우면 하루가 밀린다.
    lastCalibrationDate: toDateOnly(row.last_calibration_date),
    calibrationDueDate: toDateOnly(row.calibration_due_date),
    isActive: row.is_active,
  };
}
