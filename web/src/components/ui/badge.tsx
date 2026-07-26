import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap w-fit",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        success:
          "border-transparent bg-[color-mix(in_oklab,var(--color-success)_15%,transparent)] text-[var(--color-success)]",
        warning:
          "border-transparent bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] text-[color-mix(in_oklab,var(--color-warning)_75%,black)]",
        info: "border-transparent bg-[color-mix(in_oklab,var(--color-info)_15%,transparent)] text-[var(--color-info)]",
        destructive:
          "border-transparent bg-destructive/12 text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}

export { badgeVariants };
