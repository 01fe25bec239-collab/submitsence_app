import { Info } from "lucide-react";
import { DISCLAIMER } from "@/lib/compliance/copy";
import { cn } from "@/lib/utils";

/**
 * The standing "assistive, not certifying" reminder. Rendered persistently in
 * the app shell and reused wherever generated output is shown. `variant`
 * chooses which catalogue line to display.
 */
export function AssistiveDisclaimer({
  variant = "assistive",
  className,
}: {
  variant?: keyof typeof DISCLAIMER;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{DISCLAIMER[variant]}</span>
    </p>
  );
}
