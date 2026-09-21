import { ArrayMinSize, IsString } from 'class-validator';

export class ReorderStoreSectionsDto {
  @IsString({ each: true })
  @ArrayMinSize(1)
  section_ids!: string[];
}
