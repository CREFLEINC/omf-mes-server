import { Prisma } from '@prisma/client';
import { assertEquipmentOccupancy, lockEquipmentOccupancy } from './equipment-occupancy';
const seed = (over = {}) => ({work_order_id:1n,status_code:'PLANNED',planned_equipment_id:5n,planned_start_at:new Date('2026-11-23T01:00:00Z'),planned_end_at:new Date('2026-11-23T10:00:00Z'),work_order_resource_assignment:[],...over});
const txFor = (row = seed(), rival: object | null = null) => ({ $queryRaw:jest.fn().mockResolvedValue([{ '?column?': 1 }]), work_order:{findUniqueOrThrow:jest.fn().mockResolvedValue(row),findFirst:jest.fn().mockResolvedValue(rival)} });
describe('설비 중복 배정 원자 검사',()=>{
 it('트랜잭션 잠금은 void를 반환하지 않는 SQL을 쓴다',async()=>{
  const tx=txFor();await lockEquipmentOccupancy(tx as unknown as Prisma.TransactionClient);
  expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('SELECT 1 FROM pg_advisory_xact_lock');
 });
 it('자기·해제상태 제외와 반열림 시간 조건, 단일/N 양쪽을 검사한다',async()=>{
  const tx=txFor();await assertEquipmentOccupancy(tx as unknown as Prisma.TransactionClient,1);
  expect(tx.work_order.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({work_order_id:{not:1n},status_code:{notIn:['CANCELLED','CLOSED','COMPLETED']},planned_start_at:{lt:seed().planned_end_at},planned_end_at:{gt:seed().planned_start_at},OR:expect.arrayContaining([expect.objectContaining({work_order_resource_assignment:expect.any(Object)})])})}));
 });
 it('추가 설비 배정도 검사하고 충돌시 작업지시가 있는 필드 오류를 낸다',async()=>{
  const tx=txFor(seed({planned_equipment_id:null,work_order_resource_assignment:[{resource_type_code:'EQUIPMENT',equipment_id:7n}]}),{work_order_no:'WO-2'});
  await expect(assertEquipmentOccupancy(tx as unknown as Prisma.TransactionClient,1)).rejects.toMatchObject({response:expect.anything()});
  expect(tx.work_order.findFirst.mock.calls[0][0].where.OR[0]).toEqual({planned_equipment_id:{in:[7n]}});
 });
 it('해제 상태는 차단하지 않고 시간을 지우는 우회는 막는다',async()=>{
  for(const status of ['CANCELLED','COMPLETED','CLOSED']){
   const tx=txFor(seed({status_code:status}));await assertEquipmentOccupancy(tx as unknown as Prisma.TransactionClient,1);expect(tx.work_order.findFirst).not.toHaveBeenCalled();
  }
  const tx=txFor(seed({planned_end_at:null}));await expect(assertEquipmentOccupancy(tx as unknown as Prisma.TransactionClient,1,true)).rejects.toThrow();
 });
});
