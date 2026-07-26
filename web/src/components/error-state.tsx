import { AlertTriangle } from "lucide-react";
import { ApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

/**
 * Safe error UI. Shows a human message plus the requestId (for support), never
 * a stack trace or internal detail. Accepts an ApiError or any Error.
 */
export function ErrorState({
  error,
  title,
  className,
}: {
  error: unknown;
  title?: string;
  className?: string;
}) {
  const api = error instanceof ApiError ? error : null;
  const message =
    api?.message ??
    (error instanceof Error ? error.message : "Something went wrong.");
  const requestId = api?.requestId ?? null;

  const heading =
    title ??
    (api?.isNetwork
      ? "Can’t reach SubmitSense"
      : api?.isForbidden
        ? "You don’t have access to this"
        : "Something went wrong");

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center",
        className,
      )}
    >
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="font-medium">{heading}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {requestId ? (
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          Reference: {requestId}
        </p>
      ) : null}
    </div>
  );
}
