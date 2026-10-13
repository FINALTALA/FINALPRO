import { StarSparkleIcon } from "./AuthIcons";
import styles from "@/app/auth-pages.module.css";

// reference: .login-logo (+ svg) - the burgundy gradient square with
// the white sparkle/star mark, shared identically by every auth page
// (login/register/reset-password/reactivate). The approved brand for
// these pages is "Via" (not "FINALPRO", which the rest of the site
// still uses) - scoped here to this one accessible label, not a
// site-wide rename.
export default function AuthLogo() {
  return (
    <div className={styles.logo} role="img" aria-label="Via">
      <StarSparkleIcon />
    </div>
  );
}
