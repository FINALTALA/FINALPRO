import { ApiError } from "./api";
import { apiErrorMessage } from "./apiErrors";
import { Lang, registerTranslations } from "./i18n";

// TB-17: the API refuses an older, still-unexpired OTP for the same phone
// and purpose with OTP_SUPERSEDED (no attempt is spent) - typically the
// first SMS typed after asking for a resend. Phase A++ (item 8): every OTP
// screen's error - that one included - now comes from the one central
// place (apiErrorMessage), in the page's language; never the API's own
// English sentence.
registerTranslations({
  ar: { "otp.superseded": "أُرسل رمز أحدث، استخدم آخر رمز وصلك." },
  en: { "otp.superseded": "A newer code was sent. Use the latest code you received." },
});

export function otpErrorText(err: ApiError, lang: Lang): string {
  return apiErrorMessage(err, lang);
}
