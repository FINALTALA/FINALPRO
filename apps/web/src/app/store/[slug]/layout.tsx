import type { Metadata } from "next";

// Sprint 26: link previews for a shared store link (WhatsApp, Facebook,
// X...). The store page itself is a client component, so its metadata
// is built here on the server from the same public storefront read:
// the owner's own name, bio and cover image (logo as a fallback).
// API_INTERNAL_URL lets a deploy reach the API on a private address;
// locally it is the same public URL the browser uses.
const API_BASE_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

interface StorefrontMetaDto {
  display_name: string;
  bio: string | null;
  cover_image_url: string | null;
  logo_url: string | null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const res = await fetch(`${API_BASE_URL}/storefronts/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return { title: "متجر غير موجود | Via" };
    const s = (await res.json()) as StorefrontMetaDto;
    const title = `${s.display_name} | Via`;
    const description = (s.bio ?? `تسوّقي من ${s.display_name} وقارني الأسعار على Via.`).slice(0, 200);
    const image = s.cover_image_url ?? s.logo_url;
    const images = image ? [{ url: image, alt: s.display_name }] : undefined;
    return {
      metadataBase: new URL(SITE_URL),
      title,
      description,
      alternates: { canonical: `/store/${slug}` },
      openGraph: {
        type: "website",
        siteName: "Via",
        locale: "ar",
        url: `/store/${slug}`,
        title,
        description,
        images,
      },
      twitter: {
        card: image ? "summary_large_image" : "summary",
        title,
        description,
        images: image ? [image] : undefined,
      },
    };
  } catch {
    // API unreachable at render time - fall back to the site defaults.
    return {};
  }
}

export default function StoreLayout({ children }: { children: React.ReactNode }) {
  return children;
}
