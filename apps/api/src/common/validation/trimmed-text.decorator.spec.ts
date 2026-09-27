import { plainToInstance } from 'class-transformer';
import { IsIn, validate } from 'class-validator';
import {
  TrimmedText,
  VerificationDecisionReason,
} from './trimmed-text.decorator';

class SuspendLike {
  @TrimmedText(10, 1000)
  reason!: string;
}

class DecisionLike {
  @IsIn(['approve', 'reject', 'request_resubmission'])
  decision!: string;

  @VerificationDecisionReason()
  reason?: string;
}

const errorsFor = async <T extends object>(cls: new () => T, plain: object) =>
  validate(plainToInstance(cls, plain));

describe('TrimmedText', () => {
  it('trims before checking length, so padding cannot satisfy the minimum', async () => {
    expect(
      await errorsFor(SuspendLike, { reason: '   short   ' }),
    ).not.toHaveLength(0);
    expect(
      await errorsFor(SuspendLike, { reason: '          ' }),
    ).not.toHaveLength(0);
    expect(
      await errorsFor(SuspendLike, { reason: '  abcdefghij  ' }),
    ).toHaveLength(0);
    expect(
      plainToInstance(SuspendLike, { reason: '  abcdefghij  ' }).reason,
    ).toBe('abcdefghij');
  });

  it('rejects non-strings and over-long values', async () => {
    expect(
      await errorsFor(SuspendLike, { reason: 12345678901 }),
    ).not.toHaveLength(0);
    expect(await errorsFor(SuspendLike, {})).not.toHaveLength(0);
    expect(
      await errorsFor(SuspendLike, { reason: 'x'.repeat(1001) }),
    ).not.toHaveLength(0);
    expect(
      await errorsFor(SuspendLike, { reason: 'x'.repeat(1000) }),
    ).toHaveLength(0);
  });
});

describe('VerificationDecisionReason', () => {
  it.each(['reject', 'request_resubmission'])(
    '%s requires a trimmed 10-1000 char reason',
    async (decision) => {
      expect(await errorsFor(DecisionLike, { decision })).not.toHaveLength(0);
      expect(
        await errorsFor(DecisionLike, { decision, reason: '   ' }),
      ).not.toHaveLength(0);
      expect(
        await errorsFor(DecisionLike, { decision, reason: 'too short' }),
      ).not.toHaveLength(0);
      expect(
        await errorsFor(DecisionLike, { decision, reason: 'x'.repeat(1001) }),
      ).not.toHaveLength(0);
      expect(
        await errorsFor(DecisionLike, { decision, reason: ' a valid reason ' }),
      ).toHaveLength(0);
    },
  );

  it('approve must not carry a reason at all (even blank)', async () => {
    expect(await errorsFor(DecisionLike, { decision: 'approve' })).toHaveLength(
      0,
    );
    for (const reason of ['', '   ', 'a note that should not be here']) {
      expect(
        await errorsFor(DecisionLike, { decision: 'approve', reason }),
      ).not.toHaveLength(0);
    }
  });
});
