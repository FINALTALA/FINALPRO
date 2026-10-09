import { TrimmedText } from '../../common/validation/trimmed-text.decorator';

// Sprint 20b (FR-CART-014): the branch's own operational note on an
// order, visible only to that branch's staff/owner, never the
// customer. Always a real 1-1000 character note after trimming - no
// "clear it back to empty" path this sprint (a future enhancement,
// not a gap in what was asked for).
export class UpdateInternalOrderNoteDto {
  @TrimmedText(1, 1000)
  note!: string;
}
