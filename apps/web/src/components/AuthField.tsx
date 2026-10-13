import { ReactNode } from "react";
import styles from "@/app/auth-pages.module.css";

// reference: .login-field / .login-input-wrapper / .input-icon / input
// - the generic icon+input field shared by every non-password field
// across the three auth pages (phone, OTP code).
export default function AuthField({
  id,
  label,
  icon,
  ltr,
  ...inputProps
}: {
  id: string;
  label: string;
  icon: ReactNode;
  ltr?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "className">) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        <span className={styles.inputIcon}>{icon}</span>
        <input
          id={id}
          className={`${styles.input} ${ltr ? styles.ltrInput : ""}`}
          dir={ltr ? "ltr" : undefined}
          {...inputProps}
        />
      </div>
    </div>
  );
}
