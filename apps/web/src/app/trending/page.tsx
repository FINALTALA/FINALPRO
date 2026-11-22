import Footer from "@/components/Footer";
import TrendCollections from "@/components/trend/TrendCollections";
import TrendLook from "@/components/trend/TrendLook";
import TrendPieces from "@/components/trend/TrendPieces";
import TrendStage from "@/components/trend/TrendStage";

// The trend page hero; the site's homepage header sits on top of it
// (see AppShell). The trending pieces grid and the shop-the-look block
// follow it, then the new collections (film reel + gallery) and the site
// footer, styled as on the women page.
export default function TrendingPage() {
  return (
    <>
      <TrendStage />
      <TrendPieces />
      <TrendLook />
      <TrendCollections />
      {/* The women page's footer design (women.css is loaded by TrendLook). */}
      <div className="women-page trend-footer">
        <Footer brand="VIA" />
      </div>
    </>
  );
}
