import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * «نوافذ التوصيل v1»: every owner action that changes what can be booked
 * (capacity change, pause, resume, stopping new bookings, closing a day)
 * carries a short reason - it goes into the audit log with the actor and
 * the before/after values.
 */
export class DeliveryReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'reason must be at least 3 characters' })
  @MaxLength(300)
  reason!: string;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Stop new bookings of ONE window on ONE date (orders stay). */
export class StopWindowBookingDto extends DeliveryReasonDto {
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}
