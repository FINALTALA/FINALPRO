"use client";

import { useState } from "react";
import styles from "@/app/auth-pages.module.css";

// Presentation-only show/hide toggle for the auth pages' password
// fields (login/register/reset-password) - no new dependency, no
// change to how the value itself is read/submitted by the caller.
function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M10.6 5.2A11.6 11.6 0 0 1 12 5c7 0 11 7 11 7a14.7 14.7 0 0 1-3 3.6M6.6 6.6C3.8 8.4 1 12 1 12s4 7 11 7c1.4 0 2.7-.2 3.9-.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={`${styles.inputWrap} ${styles.inputWithToggle}`}>
        <input
          id={id}
          className={styles.input}
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
