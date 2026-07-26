import type { Metadata } from "next";
import { Check } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import type { PricingPlan } from "@/lib/api/types";
import { ErrorState } from "@/components/error-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoney, humanizeKey } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple, GST-inclusive pricing for SubmitSense.",
};

export default async function PricingPage() {
  let plans: PricingPlan[];
  try {
    // Public endpoint — no auth token, safe to cache briefly.
    plans = await apiFetch<PricingPlan[]>("/pricing/plans", {
      token: null,
      revalidate: 300,
    });
  } catch (error) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-16">
        <ErrorState error={error} title="Pricing is temporarily unavailable" />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-16">
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="mt-2 text-muted-foreground">
          Prices are in AUD and shown GST-inclusive. No automatic overage
          charges.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <PlanCard key={plan.key} plan={plan} />
        ))}
      </div>
    </main>
  );
}

function PlanCard({ plan }: { plan: PricingPlan }) {
  const price = formatMoney(plan.priceCents, plan.currency);
  const isTrial = plan.tier === "trial";
  const highlight = plan.tier === "professional";
  const usage = plan.includedUsage ?? {};

  return (
    <Card className={cn("flex flex-col", highlight && "border-primary shadow-md")}>
      <CardHeader className="gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{plan.name}</h2>
          {highlight ? <Badge>Popular</Badge> : null}
        </div>
        <div className="flex items-baseline gap-1">
          {price ? (
            <>
              <span className="text-3xl font-semibold tracking-tight">
                {price}
              </span>
              {plan.billingInterval ? (
                <span className="text-sm text-muted-foreground">
                  /{plan.billingInterval}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-2xl font-semibold tracking-tight">
              Contact sales
            </span>
          )}
        </div>
        {plan.taxInclusive && price ? (
          <p className="text-xs text-muted-foreground">incl. GST</p>
        ) : null}
        {plan.description ? (
          <p className="text-sm text-muted-foreground">{plan.description}</p>
        ) : null}
      </CardHeader>

      <CardContent className="mt-auto space-y-3">
        <ul className="space-y-1.5 text-sm">
          {Object.entries(usage).map(([key, value]) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                {formatUsage(key, value)}
              </span>
            </li>
          ))}
        </ul>
        {plan.overagePolicy ? (
          <p className="text-xs text-muted-foreground">{plan.overagePolicy}</p>
        ) : null}
        <p className="pt-1 text-xs text-muted-foreground">
          {isTrial
            ? "No card required to start."
            : plan.priceCents == null
              ? "Limits agreed in your order form."
              : "GST-inclusive, billed monthly."}
        </p>
      </CardContent>
    </Card>
  );
}

function formatUsage(key: string, value: unknown): string {
  let label = humanizeKey(key).toLowerCase();
  if (value === 1) label = label.replace(/s\b/, ""); // "1 users" → "1 user"
  if (typeof value === "number" || typeof value === "string") {
    return `${value} ${label}`;
  }
  return label;
}
