import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsString,
  Length,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Required free text, trimmed BEFORE validation (the global
 * ValidationPipe has transform: true), so a whitespace-only value
 * becomes '' and fails the length check as a 400 instead of being
 * stored as something that only looks set.
 */
export function TrimmedText(min: number, max: number) {
  return applyDecorators(
    Transform(trimString),
    IsString(),
    Length(min, max, {
      message: `must be between ${min} and ${max} characters after trimming`,
    }),
  );
}

/**
 * Sprint 16: the reviewer's `reason` on a verification decision.
 * reject / request_resubmission -> required, trimmed, 10-1000 chars.
 * approve -> must NOT be sent at all (400), so a reviewer never
 * believes a note was saved when approve stores none.
 * Reads the sibling `decision` field, so it must sit on `reason`.
 */
export function VerificationDecisionReason(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    Transform(trimString)(object, propertyName);
    registerDecorator({
      name: 'verificationDecisionReason',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const decision = (args.object as { decision?: string }).decision;
          if (decision === 'approve') {
            return value === undefined;
          }
          return (
            typeof value === 'string' &&
            value.length >= 10 &&
            value.length <= 1000
          );
        },
        defaultMessage(args: ValidationArguments) {
          const decision = (args.object as { decision?: string }).decision;
          return decision === 'approve'
            ? 'reason must not be provided when approving'
            : 'reason is required (10-1000 characters after trimming) for reject and request_resubmission';
        },
      },
    });
  };
}
