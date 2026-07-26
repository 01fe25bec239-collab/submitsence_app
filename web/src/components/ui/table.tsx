import * as React from "react";
import { cn } from "@/lib/utils";

// Accessible table primitives. Wrap in a horizontally-scrollable container so
// wide registers never force the page to scroll sideways.
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  );
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, scope = "col", ...props }: React.ComponentProps<"th">) {
  return (
    <th
      scope={scope}
      className={cn(
        "h-10 px-3 text-left align-middle font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("mt-3 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
