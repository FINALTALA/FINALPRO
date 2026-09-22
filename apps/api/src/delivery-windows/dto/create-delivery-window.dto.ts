import { IsInt, Matches, Max, Min } from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateDeliveryWindowDto {
  // 0=Sunday..6=Saturday - see DeliveryWindow's own schema.prisma
  // comment for why this convention.
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @Matches(TIME_PATTERN, { message: 'start_time must be in HH:MM (24h) form' })
  start_time!: string;

  @Matches(TIME_PATTERN, { message: 'end_time must be in HH:MM (24h) form' })
  end_time!: string;

  @IsInt()
  @Min(1)
  capacity!: number;
}
