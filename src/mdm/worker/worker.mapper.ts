import { worker, worker_qualification } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { toDateOnly } from '../date-only';

type Schemas = components['schemas'];

export function toWorker(row: worker): Schemas['Worker'] {
  return {
    workerId: Number(row.worker_id),
    workerNo: row.worker_no,
    workerName: row.worker_name,
    businessUnitId: Number(row.business_unit_id),
    plantId: Number(row.plant_id),
    departmentId: row.department_id === null ? null : Number(row.department_id),
    appUserId: row.app_user_id === null ? null : Number(row.app_user_id),
    statusCode: row.status_code,
    isActive: row.is_active,
  };
}

export function toQualification(row: worker_qualification): Schemas['WorkerQualification'] {
  return {
    workerQualificationId: Number(row.worker_qualification_id),
    workerId: Number(row.worker_id),
    qualificationTypeCode: row.qualification_type_code,
    processId: row.process_id === null ? null : Number(row.process_id),
    certificateNo: row.certificate_no,
    // @db.Date 다. valid_from 은 NOT NULL 이라 오버로드가 string 을 준다.
    validFrom: toDateOnly(row.valid_from),
    validTo: toDateOnly(row.valid_to),
    certifiedBy: row.certified_by === null ? null : Number(row.certified_by),
  };
}
