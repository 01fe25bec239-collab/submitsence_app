import Link from "next/link";
import { ArrowRight, FileSearch, ListChecks, PackageCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DEV_AUTH, DEV_TENANT_OWNER } from "@/lib/session/dev-stub";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    icon: FileSearch,
    title: "Extract, with sources cited",
    body: "Upload NATSPEC specs, drawings and addenda. SubmitSense extracts submittal requirements and cites the clause each one came from.",
  },
  {
    icon: ListChecks,
    title: "Review and match",
    body: "Build a submittal register, match requirements to your own vendor products, and see likely rejection risks — flagged for your review, not decided for you.",
  },
  {
    icon: PackageCheck,
    title: "Assemble for a human to approve",
    body: "Assemble consultant-ready packages and draft RFIs. A licensed person signs off before anything is submitted.",
  },
];

export default function LandingPage() {
  return (
    <main>
      <section className="mx-auto w-full max-w-6xl px-6 py-20 text-center">
        <p className="mx-auto mb-4 w-fit rounded-full border px-3 py-1 text-xs text-muted-foreground">
          Assistive NATSPEC submittal co-pilot
        </p>
        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Prepare submittals faster — with a human always the final approver
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-muted-foreground">
          SubmitSense helps Australian MEP &amp; fire-protection subcontractors
          turn specifications into review-ready submittal packages. It assists
          your reviewers and cites its sources. It does not certify compliance.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/pricing"
            className={cn(buttonVariants({ size: "lg" }), "gap-2")}
          >
            Start free trial
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/pricing"
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            See pricing
          </Link>
          {DEV_AUTH ? (
            <Link
              href={`/${DEV_TENANT_OWNER}/projects`}
              className={buttonVariants({ variant: "ghost", size: "lg" })}
            >
              Open demo workspace
            </Link>
          ) : null}
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-4 px-6 pb-24 md:grid-cols-3">
        {STEPS.map((step) => (
          <Card key={step.title}>
            <CardContent className="space-y-3 p-6">
              <step.icon className="size-6 text-primary" aria-hidden="true" />
              <h2 className="font-semibold">{step.title}</h2>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
