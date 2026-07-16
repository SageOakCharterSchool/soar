import { useEffect, useRef, useState } from "react";
import {
  useListIssues,
  useUpdateIssue,
  useDeleteIssue,
  useMarkIssuesSeen,
  useGetAppSettings,
  useUpdateAppSettings,
  getGetAppSettingsQueryKey,
  getGetIssuesUnseenCountQueryKey,
  type ListIssuesStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";
import { RaciChips } from "@/components/RaciChips";

const DAY_MS = 24 * 60 * 60 * 1000;

function turnaroundDays(createdAt: string, resolvedAt: string): number | null {
  const ms = new Date(resolvedAt).getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / DAY_MS;
}

function formatTurnaround(days: number): string {
  if (days < 1) return "less than a day";
  const rounded = Math.round(days);
  return rounded === 1 ? "1 day" : `${rounded} days`;
}

// Fallback while the configured threshold loads (or if it can't be fetched).
const DEFAULT_STALE_OPEN_DAYS = 7;

function openDays(createdAt: string, now: number): number | null {
  const ms = now - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / DAY_MS;
}

const FILTERS: { label: string; value: ListIssuesStatus | undefined }[] = [
  { label: "Open", value: "open" },
  { label: "Resolved", value: "resolved" },
  { label: "All", value: undefined },
];

type SortMode = "waiting" | "newest";

const SORTS: { label: string; value: SortMode }[] = [
  { label: "Longest waiting", value: "waiting" },
  { label: "Newest first", value: "newest" },
];

export default function Issues() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ListIssuesStatus | undefined>("open");
  const [sort, setSort] = useState<SortMode>("waiting");

  const { data: issues, isLoading } = useListIssues(
    status ? { status } : undefined,
  );
  const updateIssue = useUpdateIssue();
  const deleteIssue = useDeleteIssue();

  const { data: settings } = useGetAppSettings();
  const staleOpenDays = settings?.staleOpenDays ?? DEFAULT_STALE_OPEN_DAYS;
  const updateSettings = useUpdateAppSettings();
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const saveThreshold = () => {
    if (thresholdDraft === null) return;
    const parsed = parseInt(thresholdDraft, 10);
    setThresholdDraft(null);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      if (thresholdDraft.trim() !== "" && String(parsed) !== String(staleOpenDays)) {
        toast({
          title: "Invalid threshold",
          description: "Enter a whole number of days between 1 and 365.",
          variant: "destructive",
        });
      }
      return;
    }
    if (parsed === staleOpenDays) return;
    updateSettings.mutate(
      { data: { staleOpenDays: parsed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAppSettingsQueryKey() });
          toast({
            title: "Threshold updated",
            description: `Open issues are now flagged after ${parsed} ${parsed === 1 ? "day" : "days"}.`,
          });
        },
        onError: (err: any) =>
          toast({
            title: "Update failed",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

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

  // "Longest waiting" pulls open issues to the top, oldest first, so stale
  // issues are impossible to miss. Resolved issues keep newest-first order
  // below them. "Newest first" preserves the server order.
  const sortedIssues =
    sort === "waiting"
      ? [...(issues ?? [])].sort((a, b) => {
          if (a.status !== b.status) return a.status === "open" ? -1 : 1;
          const aT = new Date(a.createdAt).getTime();
          const bT = new Date(b.createdAt).getTime();
          return a.status === "open" ? aT - bT : bT - aT;
        })
      : issues ?? [];

  // The "seen on your last visit" divider only makes sense when the list is
  // in newest-first order.
  const firstOldIdx =
    sort === "newest" ? sortedIssues.findIndex((i) => !isNewForMe(i)) : -1;
  const dividerBeforeId =
    newCount > 0 && firstOldIdx > 0 ? sortedIssues[firstOldIdx]?.id : null;

  const resolvedIssues = (issues ?? []).filter((i) => i.status === "resolved");
  const resolvedDurations = resolvedIssues
    .filter((i) => i.resolvedAt)
    .map((i) => turnaroundDays(i.createdAt, i.resolvedAt!))
    .filter((d): d is number => d !== null);
  const avgTurnaround =
    resolvedDurations.length > 0
      ? resolvedDurations.reduce((a, b) => a + b, 0) / resolvedDurations.length
      : null;
  const excludedFromAvg = resolvedIssues.length - resolvedDurations.length;

  const now = Date.now();

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

  const handleDelete = (id: number) => {
    deleteIssue.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: (q) =>
              String(q.queryKey[0]).includes("issues") ||
              String(q.queryKey[0]).includes("rostering"),
          });
          toast({ title: "Issue deleted" });
        },
        onError: (err: any) =>
          toast({ title: "Delete failed", description: err?.data?.message ?? "Try again.", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-2xl font-bold tracking-tight">Issues</h2>
          {avgTurnaround !== null && (
            <Badge variant="outline" className="text-muted-foreground">
              Avg turnaround: {formatTurnaround(avgTurnaround)}
              {excludedFromAvg > 0 &&
                ` (based on ${resolvedDurations.length} of ${resolvedIssues.length} resolved issues; ${excludedFromAvg} older ${excludedFromAvg === 1 ? "issue has" : "issues have"} no recorded date)`}
            </Badge>
          )}
          {newCount > 0 && (
            <Badge className="border-transparent bg-sky-600 text-white hover:bg-sky-600 dark:bg-sky-500 dark:text-sky-950">
              {newCount} new since your last visit
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {isAdmin && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Flag open issues after
              <Input
                type="number"
                min={1}
                max={365}
                className="h-8 w-16 text-center"
                value={thresholdDraft ?? String(staleOpenDays)}
                disabled={updateSettings.isPending}
                onChange={(e) => setThresholdDraft(e.target.value)}
                onBlur={saveThreshold}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                aria-label="Days before an open issue is flagged as open too long"
              />
              days
            </label>
          )}
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
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Sort:</span>
            {SORTS.map((s) => (
              <Button
                key={s.value}
                size="sm"
                variant={sort === s.value ? "secondary" : "ghost"}
                onClick={() => setSort(s.value)}
              >
                {s.label}
              </Button>
            ))}
          </div>
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
          {sortedIssues.map((issue, idx) => (
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
                    {issue.status === "open" &&
                      (() => {
                        const d = openDays(issue.createdAt, now);
                        if (d === null) return null;
                        const stale = d >= staleOpenDays;
                        return (
                          <Badge
                            variant="outline"
                            className={
                              stale
                                ? "border-amber-500 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                                : "text-muted-foreground"
                            }
                          >
                            {stale && (
                              <span className="mr-1" aria-hidden="true">
                                ⚠
                              </span>
                            )}
                            Open for {formatTurnaround(d)}
                          </Badge>
                        );
                      })()}
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
                    {issue.status === "resolved" &&
                      (issue.resolvedAt ? (
                        <>
                          {" · Resolved on "}
                          {new Date(issue.resolvedAt).toLocaleDateString()}
                          {(() => {
                            const d = turnaroundDays(issue.createdAt, issue.resolvedAt);
                            return d !== null ? ` · Resolved in ${formatTurnaround(d)}` : null;
                          })()}
                        </>
                      ) : (
                        " · Resolved (date not recorded — resolved before dates were tracked)"
                      ))}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-2">
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
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label="Delete issue"
                          disabled={deleteIssue.isPending}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this issue?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes the issue reported for{" "}
                            {issue.appName} and its related activity. This
                            cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleDelete(issue.id)}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
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
