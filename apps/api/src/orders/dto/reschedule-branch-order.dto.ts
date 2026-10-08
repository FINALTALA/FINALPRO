import { IsString, Matches } from 'class-validator';

// Same delivery_window_id/scheduled_date shape as checkout's own
// ReserveGroupDto - a reschedule is choosing a NEW slot on the exact
// same branch calendar, not a different concept.
export class RescheduleBranchOrderDto {
  @IsString()
  delivery_window_id!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  scheduled_date!: string;
}
