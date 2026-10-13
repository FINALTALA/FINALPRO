import { OtpPurpose } from '../../generated/prisma/client';

// Part 4, H.3's wire contract uses lowercase purpose strings
// (`"signup" | "password_reset" | "phone_change"`); the Prisma enum
// stays UPPER_SNAKE_CASE for consistency with every other enum in the
// schema. This is the one place that translates between the two.
export const WIRE_OTP_PURPOSES = [
  'signup',
  'password_reset',
  'phone_change',
  // Sprint 4 (RB-ROLE-002): a StaffInvite's phone-ownership proof, using
  // this exact same generic request/verify pair - see
  // VendorsController.inviteStaff() / AuthController.acceptStaffInvite().
  'staff_invite',
  // Sprint 22 (FR-AUTH-014, PDR-034): issued only by the dedicated
  // POST /auth/reactivate-request (never by requestPasswordReset) -
  // see that endpoint's own comment for why the two must stay fully
  // independent.
  'account_reactivation',
] as const;
export type WireOtpPurpose = (typeof WIRE_OTP_PURPOSES)[number];

const WIRE_TO_PRISMA: Record<WireOtpPurpose, OtpPurpose> = {
  signup: OtpPurpose.SIGNUP,
  password_reset: OtpPurpose.PASSWORD_RESET,
  phone_change: OtpPurpose.PHONE_CHANGE,
  staff_invite: OtpPurpose.STAFF_INVITE,
  account_reactivation: OtpPurpose.ACCOUNT_REACTIVATION,
};

export function toPrismaOtpPurpose(wire: WireOtpPurpose): OtpPurpose {
  return WIRE_TO_PRISMA[wire];
}
