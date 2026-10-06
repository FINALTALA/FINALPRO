import { IsUUID } from 'class-validator';

// :id in the route is the LOSER (the product being merged away);
// into_canonical_product_id is the admin-picked survivor.
export class MergeCanonicalProductDto {
  @IsUUID()
  into_canonical_product_id!: string;
}
