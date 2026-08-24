"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/trades", label: "Trades" },
  { href: "/journal", label: "Daily Journal" },
  { href: "/performance", label: "Performance" },
  { href: "/playbooks", label: "Playbooks" },
  { href: "/tags", label: "Tags" },
  { href: "/accounts", label: "Accounts" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <aside className="w-52 shrink-0 border-r border-line bg-surface flex flex-col">
      <div className="px-4 py-5 border-b border-line">
        <Link href="/" className="font-semibold text-ink">
          Trade Journal
        </Link>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {LINKS.map((link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`block rounded-md px-3 py-2 text-sm ${
                active
                  ? "bg-page font-medium text-ink"
                  : "text-ink2 hover:bg-page"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-line">
        <p className="text-xs text-muted truncate mb-2" title={email}>
          {email}
        </p>
        <form action="/auth/signout" method="post">
          <button className="text-xs text-ink2 hover:text-ink underline">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
