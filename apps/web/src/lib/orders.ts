import { ApiError } from "./api";

// TB-9: what an order list (the customer's, the store's, a branch's)
// shows when it cannot load - never the API's raw English message.
// 401 is handled by each page (it signs out); everything else maps here.
export function orderListLoadError(err: unknown, lang: "ar" | "en" = "ar"): string {
  const en = lang === "en"; // TB-25: English beside the unchanged Arabic.
  if (err instanceof ApiError && err.status === 403) {
    return en ? "You don't have permission to view these orders." : "لا تملكين صلاحية عرض هذه الطلبات.";
  }
  return en ? "Couldn't load the orders right now. Try again shortly." : "تعذّر تحميل الطلبات الآن. حاولي مرة أخرى بعد قليل.";
}
