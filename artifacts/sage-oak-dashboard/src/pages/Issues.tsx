import { useEffect, useRef, useState } from "react";
import {
  useListIssues,
  useUpdateIssue,
  useMarkIssuesSeen,
  getGetIssuesUnseenCountQueryKey,
  type ListIssuesStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";
import { RaciChips } from "@/components/RaciChips";

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

  // Record this visit once so the Issues nav badge clears. The server
  // responds with the *previous* last-seen time, which we keep for the rest
  // of the visit so the "new" markers stay visible until the next page view.
  const markSeen = useMarkIssuesSeen();
  const markedRef = useRef(false);
  const [lastSeenAt, setLastSeenAt] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (markedRef.current) return;
    markedRef.current = true;
    markSeen.mutate(undefined, {
      onSuccess: (res) => {
        setLastSeenAt(res.lastSeenAt ?? null);
        queryClient.invalidateQueries({ queryKey: getGetIssuesUnseenCountQueryKey() });
      },
      onError: () => setLastSeenAt(null),
    });
  }, [markSeen, queryClient]);

  const isNewForMe = (issue: { createdAt: string; resolvedAt?: string | null }) => {
    if (typeof lastSeenAt !== "string") return false;
    const seen = new Date(lastSeenAt).getTime();
    if (new Date(issue.createdAt).getTime() > seen) return true;
    return issue.resolvedAt != null && new Date(issue.resolvedAt).getTime() > seen;
  };
  const newCount = (issues ?? []).filter(isNewForMe).length;
  const firstOldIdx = (issues ?? []).findIndex((i) => !isNewForMe(i));
  const dividerBeforeId =
    newCount > 0 && firstOldIdx > 0 ? (issues ?? [])[firstOldIdx]?.id : null;

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
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-2xl font-bold tracking-tight">Issues</h2>
          {newCount > 0 && (
            <Badge className="border-transparent bg-sky-600 text-white hover:bg-sky-600 dark:bg-sky-500 dark:text-sky-950">
              {newCount} new since your last visit
            </Badge>
          )}
        </div>
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
          {issues.map((issue, idx) => (
            <div key={issue.id}>
              {issue.id === dividerBeforeId && idx > 0 && (
                <div className="flex items-center gap-2 pb-2" aria-hidden="true">
                  <div className="h-px flex-1 bg-sky-300 dark:bg-sky-800" />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-sky-600 dark:text-sky-400">
                    Seen on your last visit
                  </span>
                  <div className="h-px flex-1 bg-sky-300 dark:bg-sky-800" />
                </div>
              )}
              <Card>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{issue.appName}</span>
                    <Badge variant={issue.status === "open" ? "destructive" : "secondary"}>
                      {issue.status}
                    </Badge>
                    {isNewForMe(issue) && (
                      <Badge className="h-4 border-transparent bg-sky-100 px-1.5 text-[10px] text-sky-700 hover:bg-sky-100 dark:bg-sky-900/40 dark:text-sky-300">
                        New
                      </Badge>
                    )}
                  </div>
                  <RaciChips people={issue.raci} applicationId={issue.applicationId} />
                  <p className="text-sm">{issue.comment}</p>
                  <p className="text-xs text-muted-foreground">
                    Reported by {issue.reporterName} on{" "}
                    {new Date(issue.createdAt).toLocaleDateString()}
                    {issue.status === "resolved" && issue.resolvedAt && (
                      <>
                        {" · Resolved on "}
                        {new Date(issue.resolvedAt).toLocaleDateString()}
                      </>
                    )}
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
