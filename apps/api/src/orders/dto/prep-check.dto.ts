import { IsBoolean } from 'class-validator';

/** «إدارة طلبات الفرع v2» phase 2: tick (true) or un-tick (false) one prep checklist item. */
export class PrepCheckDto {
  @IsBoolean()
  done!: boolean;
}
