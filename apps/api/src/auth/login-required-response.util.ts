/**
 * Sprint 22: the same "core operation already committed, session
 * issuance is a separate best-effort step" response shape
 * confirmPasswordReset()/acceptStaffInvite() established (Sprint 2/4) -
 * shared here because CustomersController's phone-change
 * (`PATCH /customers/me`) and AuthController's reactivateConfirm() both
 * need it too. Never promise a real session_token unconditionally: the
 * Postgres write (phone changed / account reactivated) is final the
 * moment its own transaction commits, but issuing a Redis session
 * afterward can still fail independently - that failure must never
 * turn an already-successful request into an error.
 */
export function loginRequiredResponse<TMarker extends Record<string, true>>(
  marker: TMarker,
): { session_token: null; session_status: 'LOGIN_REQUIRED' } & TMarker {
  return { session_token: null, session_status: 'LOGIN_REQUIRED', ...marker };
}
