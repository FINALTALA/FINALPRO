import { IsIn, IsOptional, IsUUID, Matches, MaxLength } from 'class-validator';
import { RETURN_QUEUE_TABS } from '../branch-return-queue.service';

// IX-P2: GET .../return-queue query. Every value is validated here (400
// otherwise); anything else is dropped by the global whitelist pipe.
export class ReturnQueueQueryDto {
  @IsOptional()
  @IsIn(RETURN_QUEUE_TABS)
  tab?: (typeof RETURN_QUEUE_TABS)[number];

  @IsOptional()
  @IsIn(['RETURN', 'EXCHANGE'])
  outcome?: 'RETURN' | 'EXCHANGE';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  /** an order or return number, or the phone's last 4 digits */
  @IsOptional()
  @MaxLength(40)
  @Matches(/^[#0-9A-Za-z\s-]*$/, {
    message: 'q must be an order number or 4 phone digits',
  })
  q?: string;

  /** owner, all branches (vendors/:vendorId/return-queue): one branch */
  @IsOptional()
  @IsUUID()
  branch?: string;

  @IsOptional()
  @Matches(/^\d{1,6}$/, { message: 'cursor must come from a previous page' })
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,2}$/, { message: 'limit must be a number from 1 to 50' })
  limit?: string;
}
