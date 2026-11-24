import { IsIn, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import { QUEUE_SORTS, QUEUE_TABS } from '../branch-order-queue.service';

// «إدارة طلبات الفرع v1»: GET .../order-queue query. Every value is
// validated here (400 otherwise); anything else is dropped by the global
// whitelist pipe.
export class BranchOrderQueueQueryDto {
  @IsOptional()
  @IsIn(QUEUE_TABS)
  tab?: (typeof QUEUE_TABS)[number];

  @IsOptional()
  @IsIn(['PICKUP', 'DELIVERY'])
  method?: 'PICKUP' | 'DELIVERY';

  @IsOptional()
  @IsIn(['true', 'false'])
  late?: 'true' | 'false';

  /** «إدارة طلبات الفرع v2» phase 1: cash on delivery only */
  @IsOptional()
  @IsIn(['COD'])
  pay?: 'COD';

  /** «إدارة طلبات الفرع v2» phase 1: placed today (Palestine date) */
  @IsOptional()
  @IsIn(['today'])
  created?: 'today';

  /** an order number, the shopper's name, or the phone's last 4 digits -
   * letters (any script), digits, spaces, «#», «-», «'» and «.» only.
   * Never a pickup code (2026-11-24: the code is only checked at hand-over). */
  @IsOptional()
  @MaxLength(40)
  @Matches(/^[#\p{L}\p{M}0-9\s'.-]*$/u, {
    message: "q must be an order number, a shopper's name or 4 phone digits",
  })
  q?: string;

  /** «نوافذ التوصيل v1»: the 7-day board opens the queue on one date / window. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
  @IsOptional()
  @IsUUID()
  window?: string;
  /** owner, all branches (vendors/:vendorId/order-queue): one branch */
  @IsOptional()
  @IsUUID()
  branch?: string;

  @IsOptional()
  @IsIn(QUEUE_SORTS)
  sort?: (typeof QUEUE_SORTS)[number];

  @IsOptional()
  @Matches(/^\d{1,6}$/, { message: 'cursor must come from a previous page' })
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,2}$/, { message: 'limit must be a number from 1 to 50' })
  limit?: string;
}
