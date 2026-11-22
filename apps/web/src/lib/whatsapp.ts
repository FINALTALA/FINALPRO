// Sprint 26: the store's own WhatsApp link (whatever the owner saved
// on /vendor/[id]/storefront), opened with a ready-made first message.
// Only genuine WhatsApp chat links get a ?text= - anything else the
// owner pasted is returned untouched rather than guessed at.
const WHATSAPP_HOSTS = new Set(["wa.me", "api.whatsapp.com", "whatsapp.com", "www.whatsapp.com"]);

export function whatsappChatUrl(url: string, message: string): string {
  try {
    const parsed = new URL(url);
    if (!WHATSAPP_HOSTS.has(parsed.hostname)) return url;
    parsed.searchParams.set("text", message);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function storeWhatsappMessage(storeName: string): string {
  return `مرحباً ${storeName}، وصلت إلى متجركم عبر Via وأودّ الاستفسار.`;
}

export function productWhatsappMessage(storeName: string, productTitle: string, price?: string | null): string {
  const priceLine = price ? ` (${price} ₪)` : "";
  return `مرحباً ${storeName}، أودّ الاستفسار عن المنتج: ${productTitle}${priceLine}`;
}
