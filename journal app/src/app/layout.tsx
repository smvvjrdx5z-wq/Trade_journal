import type { Metadata } from "next";
import "./globals.css";
import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Trade Journal",
  description:
    "A TradeZella-style trading journal: trades, daily reviews, playbooks, tags and the full performance dashboard.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en">
      <body>
        {user ? (
          <div className="flex min-h-screen">
            <Nav email={user.email ?? ""} />
            <main className="flex-1 p-6 max-w-7xl mx-auto w-full min-w-0">
              {children}
            </main>
          </div>
        ) : (
          <main className="min-h-screen">{children}</main>
        )}
      </body>
    </html>
  );
}
