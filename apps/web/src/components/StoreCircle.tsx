import Link from "next/link";
import SafeImage from "./SafeImage";

// A round store logo (real logoUrl, else the store's first letter) that
// optionally links to a specific store view.
export default function StoreCircle({
  name,
  logoUrl,
  href,
  size = 30,
}: {
  name: string;
  logoUrl: string | null;
  href?: string;
  size?: number;
}) {
  const inner = logoUrl ? (
    <SafeImage src={logoUrl} alt={name} className="store-logo-img" />
  ) : (
    <span className="store-logo-placeholder">{name.slice(0, 1)}</span>
  );
  const style = { width: size, height: size };
  if (!href) {
    return (
      <span className="store-logo-button" style={style} title={name}>
        {inner}
      </span>
    );
  }
  return (
    <Link href={href} className="store-logo-button" style={style} title={name} aria-label={name}>
      {inner}
    </Link>
  );
}
