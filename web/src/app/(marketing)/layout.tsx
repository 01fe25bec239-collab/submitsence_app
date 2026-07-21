import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AssistiveDisclaimer } from "@/components/assistive-disclaimer";
import { buttonVariants } from "@/components/ui/button";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
            SubmitSense
          </Link>
          <nav className="flex items-center gap-2 text-sm" aria-label="Marketing">
            <Link
              href="/pricing"
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground"
            >
              Pricing
            </Link>
            <Link
              href="/pricing"
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              Start free trial
            </Link>
          </nav>
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-6xl space-y-2 px-6 py-6">
          <AssistiveDisclaimer />
          <p className="text-xs text-muted-foreground">
            Built for Australian MEP &amp; fire-protection subcontractors. Data
            hosted in Australia.
          </p>
        </div>
      </footer>
    </div>
  );
}
