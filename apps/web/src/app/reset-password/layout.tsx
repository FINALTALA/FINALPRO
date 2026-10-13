import type { Metadata } from "next";

// Scoped to this one route only (a nested layout's title replaces the
// root layout's, it doesn't rename the app anywhere else) - the
// approved brand for the auth pages is "Via", not "FINALPRO".
export const metadata: Metadata = {
  title: "استعادة كلمة المرور | Via",
};

export default function ResetPasswordLayout({ children }: LayoutProps<"/reset-password">) {
  return children;
}
