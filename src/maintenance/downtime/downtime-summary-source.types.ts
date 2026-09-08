export interface DowntimeSummarySourceQuery {
  readonly plantId?: number;
  readonly equipmentGroupId?: number;
  readonly equipmentId?: number;
  readonly startedFrom: string;
  readonly startedTo: string;
}

export interface SummaryPlantSource {
  readonly plantId: string;
  readonly businessUnitId: string | null;
  readonly timezone: string;
  readonly rangeStartUs: bigint;
  readonly rangeEndUs: bigint;
}

export interface SummaryEquipmentSource {
  readonly equipmentId: string;
  readonly equipmentCode: string;
  readonly equipmentName: string;
  readonly plantId: string;
  readonly productionLineId: string | null;
}

export interface SummarySessionSource {
  readonly sessionId: string;
  readonly plantId: string;
  readonly equipmentId: string | null;
  readonly startedAtUs: bigint;
  readonly endedAtUs: bigint;
  readonly rangeStartUs: bigint;
  readonly rangeEndUs: bigint;
}

export interface SummaryDowntimeSource {
  readonly downtimeId: string;
  readonly plantId: string;
  readonly equipmentId: string;
  readonly reasonCode: string | null;
  readonly reasonName: string | null;
  readonly startedAtUs: bigint;
  readonly endedAtUs: bigint;
  readonly rangeStartUs: bigint;
  readonly rangeEndUs: bigint;
}

export interface DowntimeSummarySource {
  readonly plants: readonly SummaryPlantSource[];
  readonly equipment: readonly SummaryEquipmentSource[];
  readonly sessions: readonly SummarySessionSource[];
  readonly downtimes: readonly SummaryDowntimeSource[];
  readonly openIntervalCount: number;
}
