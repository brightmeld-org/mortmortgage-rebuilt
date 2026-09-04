-- task-006 additive changes.
--
-- (1) Session.mfaPendingAt: pre-MFA session state (§4.1.4). Non-null while the password factor
--     has been verified but the MFA factor has not; such a session never authenticates through
--     the shared session resolver. task-007's POST /api/auth/mfa/verify clears it on success and
--     uses it to anchor the 10-minute enrollment-scoped window.
ALTER TABLE "Session" ADD COLUMN     "mfaPendingAt" TIMESTAMP(3);

-- (2) PasswordResetToken.purpose: two additional single-use hashed-token purposes (NFR-011,
--     INV-010): 'verify-new-email' for the REQ-041 change-email re-verification flow and
--     'sms-verify' for the §4.2.12 SMS mobile-number verification code. Additive CHECK swap —
--     existing values remain valid.
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_purpose_check";
ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_purpose_check" CHECK (
    "purpose" IN ('reset', 'verify-email', 'verify-new-email', 'invite', 'sms-verify')
  );
