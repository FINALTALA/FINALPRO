import { IsInt, IsObject, Min } from 'class-validator';

/** The draft version the owner's screen last saw (a stale write is refused). */
export class StoreHomeVersionDto {
  @IsInt()
  @Min(0)
  version!: number;
}

/**
 * The whole draft document. `layout` is checked field by field by
 * parseLayout() (store-home.layout.ts) - a closed shape, nothing unknown kept.
 */
export class SaveStoreHomeDraftDto extends StoreHomeVersionDto {
  @IsObject()
  layout!: Record<string, unknown>;
}
