import { useState } from "react";
import {
  useListIssues,
  useUpdateIssue,
  type ListIssuesStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";

const FILTERS: { label: string; value: ListIssuesStatus | undefined }[] = [
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
  { label: "All", value: undefined },
];

export default function Issues() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ListIssuesStatus | undefined>("open");

  const { data: issues, isLoading } = useListIssues(
    status ? { status } : undefined,
  );
  const updateIssue = useUpdateIssue();

  const setIssueStatus = (id: number, next: "open" | "resolved") => {
    updateIssue.mutate(
      { id, data: { status: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: (q) =>
              String(q.queryKey[0]).includes("issues") ||
              String(q.queryKey[0]).includes("rostering"),
          });
        },
        onError: (err: any) =>
          toast({ title: "Update failed", description: err?.data?.message ?? "Try again.", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-bold tracking-tight">Issues</h2>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.label}
              size="sm"
              variant={status === f.value ? "default" : "outline"}
              onClick={() => setStatus(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !issues || issues.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No {status ?? ""} issues. Staff can report issues from the Rostering board.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <Card key={issue.id}>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{issue.appName}</span>
                    <Badge variant={issue.status === "open" ? "destructive" : "secondary"}>
                      {issue.status}
                    </Badge>
                  </div>
                  <p className="text-sm">{issue.comment}</p>
                  <p className="text-xs text-muted-foreground">
                    Reported by {issue.reporterName} on{" "}
                    {new Date(issue.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={updateIssue.isPending}
                    onClick={() =>
                      setIssueStatus(issue.id, issue.status === "open" ? "resolved" : "open")
                    }
                  >
                    {issue.status === "open" ? "Mark resolved" : "Reopen"}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
