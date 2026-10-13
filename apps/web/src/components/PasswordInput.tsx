"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon, LockIcon } from "./AuthIcons";
import styles from "@/app/auth-pages.module.css";

// reference: .login-input-wrapper (+ .input-icon lock, #password,
// .password-toggle) - leading lock icon, RTL-aligned text reserving
// space on the left for the toggle button, exactly as the reference
// positions it.
export default function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  placeholder,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  placeholder?: string;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        <span className={styles.inputIcon}>
          <LockIcon />
        </span>
        <input
          id={id}
          className={`${styles.input} ${styles.passwordField}`}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        />
        <button
          type="button"
          className={styles.toggleButton}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          aria-pressed={visible}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </div>
  );
}
