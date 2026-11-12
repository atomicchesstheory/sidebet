import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, DM_Sans } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Wordmark } from "@/components/brand";
import { Nav } from "@/components/nav";
import { getSessionUser } from "@/lib/server/auth";
import { config } from "@/lib/server/config";
import { ensureReady } from "@/lib/server/ready";
import { getWallet } from "@/lib/server/wallet";

const barlow = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700", "800"], style: ["normal", "italic"], variable: "--font-barlow" });
const dm = DM_Sans({ subsets: ["latin"], variable: "--font-dm" });

export const metadata: Metadata = {
  title: { default: "Side Bet — Pick a side. Put up chips.", template: "%s · Side Bet" },
  description: "Play-chip bets and custom draft contests for friendly rivalries.",
};
export const viewport: Viewport = { themeColor: "#131417", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureReady();
  const user = await getSessionUser();
  const wallet = user ? await getWallet(user.id) : null;
  return (
    <html lang="en" className={`${barlow.variable} ${dm.variable}`}>
      <body className="min-h-dvh">
        {config.mode === "demo" && (
          <div className="border-b border-lime/30 bg-lime/10 px-4 py-1.5 text-center text-xs text-lime">
            <strong className="chip-label">Demo mode</strong> · fictional data, local accounts, embedded database
            {" "}· chips are free and worth nothing
          </div>
        )}
        <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
          <div className="relative mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
            <Link href="/" aria-label="Side Bet home">
              <Wordmark />
            </Link>
            <Nav user={user} balance={wallet?.balance ?? null} canClaim={wallet?.can_claim ?? false} />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-cream-faint">
          Side Bet chips are free play chips. They can&apos;t be bought, sold or redeemed.
        </footer>
      </body>
    </html>
  );
}
