"use client";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-4 py-8">
      <ErrorState error={error} />
      <div className="flex justify-center">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
