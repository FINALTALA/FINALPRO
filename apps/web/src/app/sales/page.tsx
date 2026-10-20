import { redirect } from "next/navigation";

/**
 * The public catalogue is the current customer-facing destination for
 * promotions. Keeping this route lets campaign links use a stable /sales URL
 * while the catalogue's sales-only API filter is introduced.
 */
export default function SalesPage() {
  redirect("/discovery");
}
