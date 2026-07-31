import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListTerms,
  useGetRosteringBoard,
  useGetRosteringSummary,
  useToggleUpvote,
  useReportIssue,
  useUpdateAppTermStatus,
  useUpdateAppDayOneCritical,
  useCreateApp,
  useRenameApp,
  useDeleteApp,
  useRestoreDeletedApp,
  useListUserOptions,
  useCreateTerm,
  useUpdateTerm,
  useCopyTermStatuses,
  useGetRosteringActivity,
  useMarkRosteringSeen,
  getGetRosteringUnseenCountQueryKey,
  type ActivityEvent,
  type ArchivedActivityEvent,
  useGetPublicAppSettings,
  type BoardRow,
  type Term,
  type AppTermStatusUpdate,
  type DropdownOption,
} from "@workspace/api-client-react";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useStoredId } from "@/hooks/useStoredId";
import { useStoredValue, oneOf, parseBool } from "@/hooks/useStoredValue";
import { RaciChips } from "@/components/RaciChips";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { ThumbsUp, Flag, Pencil, Settings2, History, PlusCircle, CheckCircle2, RefreshCw, Archive, Download, Users2, Trash2, AlertTriangle, RotateCcw } from "lucide-react";
import { SortableHead, useTableSort } from "@/hooks/useTableSort";

const boardColumnAccessors = {
  appName: (r: BoardRow) => r.appName,
  studentSharingStatus: (r: BoardRow) => r.studentSharingStatus,
  staffSharingStatus: (r: BoardRow) => r.staffSharingStatus,
  syncMethod: (r: BoardRow) => r.syncMethod,
  owner: (r: BoardRow) => r.owner,
  notes: (r: BoardRow) => r.notes,
  updatedAt: (r: BoardRow) => r.updatedAt,
};

// Fallback options used until the settings-driven list loads. Colors for the
// well-known status values stay stable; custom values get palette colors.
const DEFAULT_STATUS_OPTIONS: DropdownOption[] = [
  { value: "not_started", label: "Not started", active: true },
  { value: "in_progress", label: "In progress", active: true },
  { value: "complete", label: "Complete", active: true },
  { value: "needs_review", label: "Needs review", active: true },
];

const STATUS_CLASSNAMES: Record<string, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  complete: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  needs_review: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

const STATUS_PALETTE = [
  "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200",
  "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
];

type StatusMeta = Record<string, { label: string; className: string }>;

function buildStatusMeta(options: DropdownOption[]): StatusMeta {
  const meta: StatusMeta = {};
  options.forEach((o, i) => {
    meta[o.value] = {
      label: o.label,
      className:
        STATUS_CLASSNAMES[o.value] ?? STATUS_PALETTE[i % STATUS_PALETTE.length]!,
    };
  });
  return meta;
}

/** Settings-driven sharing status options with color metadata. */
function useStatusOptions() {
  const { data: settings } = useGetPublicAppSettings();
  return useMemo(() => {
    const options = settings?.sharingStatusOptions ?? DEFAULT_STATUS_OPTIONS;
    return {
      options,
      activeOptions: options.filter((o) => o.active),
      meta: buildStatusMeta(options),
    };
  }, [settings]);
}

function StatusBadge({ status, meta }: { status: string; meta: StatusMeta }) {
  const m = meta[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={`border-transparent ${m.className}`}>{m.label}</Badge>;
}

function termRelativeLabel(term: Term, terms: Term[]): string | null {
  const current = terms.find((t) => t.isCurrent);
  if (!current) return null;
  const diff = term.sortOrder - current.sortOrder;
  if (diff === 0) return "Current";
  if (diff === -1) return "Previous";
  if (diff === 1) return "Next";
  return null;
}

const invalidateBoard = (queryClient: ReturnType<typeof useQueryClient>) =>
  queryClient.invalidateQueries({
    predicate: (q) =>
      String(q.queryKey[0]).includes("rostering") ||
      String(q.queryKey[0]).includes("issues") ||
      String(q.queryKey[0]).includes("terms"),
  });

const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isRecent(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() <= RECENT_WINDOW_MS;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const EVENT_META: Record<
  string,
  { label: string; Icon: typeof History; cls: string }
> = {
  status_change: { label: "Status change", Icon: RefreshCw, cls: "text-amber-600 dark:text-amber-400" },
  app_added: { label: "New app", Icon: PlusCircle, cls: "text-sky-600 dark:text-sky-400" },
  app_renamed: { label: "App renamed", Icon: Pencil, cls: "text-sky-600 dark:text-sky-400" },
  app_removed: { label: "App removed", Icon: Trash2, cls: "text-red-600 dark:text-red-400" },
  app_restored: { label: "App restored", Icon: RotateCcw, cls: "text-emerald-600 dark:text-emerald-400" },
  issue_reported: { label: "Issue reported", Icon: Flag, cls: "text-red-600 dark:text-red-400" },
  issue_resolved: { label: "Issue resolved", Icon: CheckCircle2, cls: "text-emerald-600 dark:text-emerald-400" },
  raci_change: { label: "RACI change", Icon: Users2, cls: "text-violet-600 dark:text-violet-400" },
};

function RecentActivity({ termId }: { termId: number }) {
  const [expanded, setExpanded] = useState(false);
  const { data: activity } = useGetRosteringActivity(
    { termId, limit: 50 },
    { query: { enabled: termId != null } as any },
  );

  // On first mount, record this visit; the server responds with the *previous*
  // last-seen time, which we keep for the rest of the visit so the "new"
  // markers stay visible until the next page view.
  const markSeen = useMarkRosteringSeen();
  const queryClient = useQueryClient();
  const [lastSeenAt, setLastSeenAt] = useState<string | null | undefined>(undefined);
  const markedRef = useRef(false);
  useEffect(() => {
    if (markedRef.current) return;
    markedRef.current = true;
    markSeen.mutate(undefined, {
      onSuccess: (res) => {
        setLastSeenAt(res.lastSeenAt ?? null);
        queryClient.invalidateQueries({ queryKey: getGetRosteringUnseenCountQueryKey() });
      },
      onError: () => setLastSeenAt(null),
    });
  }, [markSeen, queryClient]);

  const events = (activity ?? []) as ActivityEvent[];
  if (events.length === 0) return null;

  const isNewForMe = (e: ActivityEvent) =>
    typeof lastSeenAt === "string" &&
    new Date(e.createdAt).getTime() > new Date(lastSeenAt).getTime();
  const newCount = events.filter(isNewForMe).length;
  const shown = expanded ? events : events.slice(0, Math.max(5, newCount));
  const recentCount = events.filter((e) => isRecent(e.createdAt)).length;
  const firstOldIdx = shown.findIndex((e) => !isNewForMe(e));
  const dividerBeforeId =
    newCount > 0 && firstOldIdx > 0 ? shown[firstOldIdx]?.id : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Recent changes</h3>
            {newCount > 0 && (
              <Badge className="border-transparent bg-sky-600 text-white hover:bg-sky-600 dark:bg-sky-500 dark:text-sky-950">
                {newCount} new since your last visit
              </Badge>
            )}
            {recentCount > 0 && (
              <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                {recentCount} in last 3 days
              </Badge>
            )}
          </div>
          {events.length > 5 && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : `Show all ${events.length}`}
            </Button>
          )}
        </div>
        <ul className="space-y-2">
          {shown.map((e) => {
            const meta = EVENT_META[e.eventType] ?? EVENT_META.status_change;
            const isNew = isNewForMe(e);
            return (
              <li key={e.id}>
                {e.id === dividerBeforeId && (
                  <div className="flex items-center gap-2 py-1" aria-hidden="true">
                    <div className="h-px flex-1 bg-sky-300 dark:bg-sky-800" />
                    <span className="text-[10px] font-medium uppercase tracking-wide text-sky-600 dark:text-sky-400">
                      Seen on your last visit
                    </span>
                    <div className="h-px flex-1 bg-sky-300 dark:bg-sky-800" />
                  </div>
                )}
                <div className="flex items-start gap-2 text-sm">
                  <meta.Icon className={`h-4 w-4 mt-0.5 shrink-0 ${meta.cls}`} />
                  <div className="min-w-0">
                    <span className="font-medium">{e.appName}</span>
                    {isNew && (
                      <Badge className="ml-1.5 h-4 border-transparent bg-sky-100 px-1.5 text-[10px] text-sky-700 hover:bg-sky-100 dark:bg-sky-900/40 dark:text-sky-300">
                        New
                      </Badge>
                    )}
                    <span className="text-muted-foreground"> — {e.detail}</span>
                    <div className="text-xs text-muted-foreground">
                      {relativeTime(e.createdAt)}
                      {e.actorName ? ` · ${e.actorName}` : ""}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "\n" && !inQuotes) {
      if (current.length > 0) records.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

export function ArchiveDialog() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [fetchedCount, setFetchedCount] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const PAGE_SIZE = 500;

  const {
    data,
    isLoading,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [
      "rostering-activity-archive",
      { search: debouncedSearch, from: fromDate, to: toDate },
    ],
    queryFn: async ({ pageParam, signal }) => {
      const { offset, snapshot } = pageParam;
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (debouncedSearch) qs.set("search", debouncedSearch);
      if (fromDate) qs.set("from", fromDate);
      if (toDate) qs.set("to", toDate);
      // Pin later pages to the snapshot the server took on the first page so
      // rows archived while browsing can't shift offsets (duplicates/gaps).
      // If the header is missing (proxy stripped it / older server), we
      // deliberately fall back to unpinned offsets so browsing keeps working.
      if (snapshot) qs.set("archivedBefore", snapshot);
      const res = await fetch(`/api/rostering/activity/archive?${qs.toString()}`, {
        credentials: "include",
        signal,
      });
      if (!res.ok) {
        throw new Error(`Could not load archived history (${res.status})`);
      }
      return {
        rows: (await res.json()) as ArchivedActivityEvent[],
        snapshot: snapshot ?? res.headers.get("X-Archive-Snapshot"),
      };
    },
    initialPageParam: { offset: 0, snapshot: null as string | null },
    getNextPageParam: (lastPage, allPages) =>
      lastPage.rows.length === PAGE_SIZE
        ? {
            offset: allPages.reduce((sum, page) => sum + page.rows.length, 0),
            snapshot: lastPage.snapshot,
          }
        : undefined,
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!isError || !error) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    toast({
      variant: "destructive",
      title: "Could not load archived history",
      description: error instanceof Error ? error.message : "Please try again.",
    });
  }, [isError, error, toast]);

  const rows = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data],
  );
  const hasMore = Boolean(hasNextPage);
  const loadingMore = isFetchingNextPage;

  const loadMore = () => {
    if (isFetchingNextPage || isLoading) return;
    void fetchNextPage();
  };

  const hasFilters = Boolean(debouncedSearch || fromDate || toDate);

  // Denominator guards against the total shrinking or growing mid-export
  // (rows can be archived while pages are being fetched).
  const exportPercent =
    totalCount != null
      ? Math.min(
          100,
          Math.round(
            (fetchedCount / Math.max(totalCount, fetchedCount, 1)) * 100,
          ),
        )
      : 0;

  const cancelDownload = () => {
    abortRef.current?.abort();
  };

  const downloadCsv = async () => {
    if (downloading) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setFetchedCount(0);
    setTotalCount(null);
    try {
      const pageSize = 1000;
      const parts: string[] = [];
      let offset = 0;
      let rowCount = 0;
      // Snapshot taken by the server on the first page; passing it back on
      // later pages keeps offsets stable even if the nightly retention job
      // archives new rows mid-export (otherwise rows could be duplicated or
      // skipped).
      let snapshot: string | null = null;
      // Deliberate degraded mode: if the header is missing (stripped by a
      // proxy, or an older server build), the export still runs to completion
      // with unpinned offsets, and we warn the user that rows archived
      // mid-export could shift pages (rare duplicates/gaps).
      let warnedMissingSnapshot = false;
      for (;;) {
        const qs = new URLSearchParams({
          format: "csv",
          limit: String(pageSize),
          offset: String(offset),
        });
        if (debouncedSearch) qs.set("search", debouncedSearch);
        if (fromDate) qs.set("from", fromDate);
        if (toDate) qs.set("to", toDate);
        if (snapshot) qs.set("archivedBefore", snapshot);
        const res = await fetch(`/api/rostering/activity/archive?${qs.toString()}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Export failed (${res.status})`);
        }
        if (!snapshot) {
          snapshot = res.headers.get("X-Archive-Snapshot");
          if (!snapshot && !warnedMissingSnapshot) {
            warnedMissingSnapshot = true;
            toast({
              title: "Export running without a consistency snapshot",
              description:
                "The server did not provide a snapshot marker, so rows archived during the export could be duplicated or skipped. The download will still complete.",
            });
          }
        }
        const totalHeader = res.headers.get("X-Total-Count");
        if (totalHeader != null) {
          const total = parseInt(totalHeader, 10);
          if (!Number.isNaN(total)) setTotalCount(total);
        }
        const text = await res.text();
        const records = splitCsvRecords(text);
        // First record of every page is the header; keep it only once.
        const dataRecords = records.slice(1);
        if (parts.length === 0 && records.length > 0) parts.push(records[0]);
        parts.push(...dataRecords);
        rowCount += dataRecords.length;
        setFetchedCount(rowCount);
        if (dataRecords.length < pageSize) break;
        offset += pageSize;
      }
      if (controller.signal.aborted) return;
      const blob = new Blob([parts.join("\n") + "\n"], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "activity-archive.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      toast({
        variant: "destructive",
        title: "Download failed",
        description:
          err instanceof Error ? err.message : "Could not export the archive. Please try again.",
      });
    } finally {
      abortRef.current = null;
      setDownloading(false);
      setFetchedCount(0);
      setTotalCount(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Archive className="h-4 w-4 mr-1.5" />
          Archived history
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Archived activity history</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Changes older than 12 months are moved here so the recent feed stays fast
          while the full audit trail is preserved.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              placeholder="Search by app, actor, or detail…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground" htmlFor="archive-from">
                From
              </label>
              <Input
                id="archive-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground" htmlFor="archive-to">
                To
              </label>
              <Input
                id="archive-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
            {hasFilters && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setFromDate("");
                  setToDate("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {hasFilters
              ? "No archived events match your filters."
              : "Nothing archived yet. Events appear here once they age past 12 months."}
          </p>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto pr-1">
              <ul className="space-y-2">
                {rows.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 text-sm">
                    <History className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <span className="font-medium">{e.appName}</span>
                      <span className="text-muted-foreground"> — {e.detail}</span>
                      <div className="text-xs text-muted-foreground">
                        {new Date(e.createdAt).toLocaleDateString()}
                        {e.actorName ? ` · ${e.actorName}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="flex justify-center py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
              {hasMore && !loadingMore && (
                <p className="text-center text-xs text-muted-foreground pb-1">
                  Showing {rows.length.toLocaleString()} events — more available
                </p>
              )}
            </div>
            <DialogFooter className="items-center gap-2 sm:gap-2">
              {downloading && (
                <div className="flex flex-1 items-center gap-2 min-w-0">
                  {totalCount != null && (
                    <Progress
                      value={exportPercent}
                      className="h-2 flex-1 min-w-16"
                      aria-label="Export progress"
                    />
                  )}
                  <span
                    className="text-xs text-muted-foreground whitespace-nowrap"
                    aria-live="polite"
                  >
                    {totalCount != null
                      ? `${fetchedCount.toLocaleString()} of ${Math.max(totalCount, fetchedCount).toLocaleString()} rows fetched…`
                      : `${fetchedCount.toLocaleString()} rows fetched…`}
                  </span>
                </div>
              )}
              {downloading && (
                <Button size="sm" variant="ghost" onClick={cancelDownload}>
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={downloadCsv}
                disabled={downloading}
              >
                <Download className="h-4 w-4 mr-1.5" />
                {downloading ? "Exporting…" : "Download CSV"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const NO_OWNER = "__none__";

function EditStatusDialog({ row, termId }: { row: BoardRow; termId: number }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AppTermStatusUpdate>({});
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateAppTermStatus();
  const updateDayOne = useUpdateAppDayOneCritical();
  const renameApp = useRenameApp();
  const deleteApp = useDeleteApp();
  const restoreApp = useRestoreDeletedApp();
  const [dayOneCritical, setDayOneCritical] = useState(row.dayOneCritical);
  const [appName, setAppName] = useState(row.appName);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { data: userOptions = [] } = useListUserOptions();
  const { options: statusOptions, activeOptions } = useStatusOptions();

  const openWith = () => {
    setDayOneCritical(row.dayOneCritical);
    setAppName(row.appName);
    setConfirmingDelete(false);
    setForm({
      studentSharingStatus: row.studentSharingStatus,
      staffSharingStatus: row.staffSharingStatus,
      syncMethod: (row.syncMethod as AppTermStatusUpdate["syncMethod"]) ?? undefined,
      lastSyncedAt: row.lastSyncedAt ?? undefined,
      owner: row.owner ?? undefined,
      notes: row.notes ?? undefined,
    });
  };

  const save = () => {
    const newName = appName.trim();
    if (newName && newName !== row.appName) {
      renameApp.mutate(
        { id: row.applicationId, data: { name: newName } },
        {
          onSuccess: (res) => {
            invalidateBoard(queryClient);
            toast({ title: "App renamed", description: `Now shown as ${res.name}.` });
          },
          onError: (err: any) => {
            setAppName(row.appName);
            toast({
              title: "Rename failed",
              description: err?.data?.message ?? "Try again.",
              variant: "destructive",
            });
          },
        },
      );
    }
    update.mutate(
      { id: row.statusId, data: form },
      {
        onSuccess: () => {
          if (dayOneCritical !== row.dayOneCritical) {
            updateDayOne.mutate(
              { id: row.applicationId, data: { dayOneCritical } },
              {
                onSuccess: () => invalidateBoard(queryClient),
                onError: (err: any) =>
                  toast({
                    title: "Day 1 flag not saved",
                    description: err?.data?.message ?? "Try again.",
                    variant: "destructive",
                  }),
              },
            );
          }
          invalidateBoard(queryClient);
          setOpen(false);
        },
        onError: (err: any) =>
          toast({ title: "Save failed", description: err?.data?.message ?? "Try again.", variant: "destructive" }),
      },
    );
  };

  const confirmDelete = () =>
    deleteApp.mutate(
      { id: row.applicationId },
      {
        onSuccess: (res) => {
          invalidateBoard(queryClient);
          setOpen(false);
          toast({
            title: "App deleted",
            description: `${res.name} was removed, along with ${res.statusRows} status row${res.statusRows === 1 ? "" : "s"}, ${res.issues} issue${res.issues === 1 ? "" : "s"} and ${res.upvotes} upvote${res.upvotes === 1 ? "" : "s"}.${res.raciRowsUnlinked > 0 ? ` ${res.raciRowsUnlinked} RACI row${res.raciRowsUnlinked === 1 ? " was" : "s were"} unlinked.` : ""}`,
            action: (
              <ToastAction
                altText="Undo delete"
                data-testid="button-undo-delete-app"
                onClick={() =>
                  restoreApp.mutate(
                    { id: res.deletedAppId },
                    {
                      onSuccess: (restored) => {
                        invalidateBoard(queryClient);
                        toast({
                          title: "App restored",
                          description: `${restored.name} is back with ${restored.statusRows} status row${restored.statusRows === 1 ? "" : "s"}${restored.raciRowsRelinked > 0 ? ` and ${restored.raciRowsRelinked} RACI row${restored.raciRowsRelinked === 1 ? "" : "s"} re-linked` : ""}.`,
                        });
                      },
                      onError: (err: any) =>
                        toast({
                          title: "Restore failed",
                          description: err?.data?.message ?? "Try again.",
                          variant: "destructive",
                        }),
                    },
                  )
                }
              >
                Undo
              </ToastAction>
            ),
          });
        },
        onError: (err: any) =>
          toast({
            title: "Delete failed",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );

  const statusSelect = (
    field: "studentSharingStatus" | "staffSharingStatus",
    label: string,
  ) => {
    const current = form[field];
    // Show active options, plus the row's current value if it was deactivated
    // so the picker still displays it (the server allows keeping it).
    const choices = [...activeOptions];
    if (current && !choices.some((o) => o.value === current)) {
      const existing = statusOptions.find((o) => o.value === current);
      choices.push(existing ?? { value: current, label: current, active: false });
    }
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Select
          value={current ?? activeOptions[0]?.value ?? "not_started"}
          onValueChange={(v) => setForm((f) => ({ ...f, [field]: v as any }))}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {choices.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) openWith(); }}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Edit ${row.appName}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {row.appName}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5 col-span-2">
            <Label htmlFor="edit-app-name">App name</Label>
            <Input
              id="edit-app-name"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              data-testid="input-edit-app-name"
            />
            {appName.trim() !== row.appName && (
              <p className="text-xs text-muted-foreground">
                Renaming keeps this app's history, issues and RACI links. Apps
                that come from usage imports can't be renamed, since imports
                match apps by name.
              </p>
            )}
          </div>
          {statusSelect("studentSharingStatus", "Student data sharing")}
          {statusSelect("staffSharingStatus", "Staff data sharing")}
          <label className="col-span-2 flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={dayOneCritical}
              onCheckedChange={(v) => setDayOneCritical(v === true)}
              data-testid="checkbox-day-one-critical"
            />
            Critically needed for day one of the school year
          </label>
          <div className="space-y-1.5">
            <Label>Sync method</Label>
            <Select
              value={form.syncMethod ?? undefined}
              onValueChange={(v) => setForm((f) => ({ ...f, syncMethod: v as any }))}
            >
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {["SSO", "SAML", "manual", "other"].map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Last synced</Label>
            <Input
              type="date"
              value={form.lastSyncedAt ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, lastSyncedAt: e.target.value || null }))}
            />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Owner</Label>
            <Select
              value={form.owner ?? NO_OWNER}
              onValueChange={(v) => setForm((f) => ({ ...f, owner: v === NO_OWNER ? null : v }))}
            >
              <SelectTrigger><SelectValue placeholder="Who is responsible?" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OWNER}>
                  <span className="text-muted-foreground">No owner</span>
                </SelectItem>
                {form.owner && !userOptions.some((u) => u.displayName === form.owner) && (
                  <SelectItem value={form.owner}>{form.owner} (not a dashboard user)</SelectItem>
                )}
                {userOptions.map((u) => (
                  <SelectItem key={u.id} value={u.displayName}>
                    {u.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Notes</Label>
            <Textarea
              value={form.notes ?? ""}
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value || null }))}
            />
          </div>
        </div>
        {confirmingDelete ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-2" data-testid="confirm-delete-app">
            <div className="flex items-start gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              <div>
                <p className="font-medium">Delete {row.appName}?</p>
                <p className="text-muted-foreground">
                  This permanently removes the app from every term's board,
                  along with its issues{row.openIssueCount > 0 ? ` (${row.openIssueCount} open)` : ""},
                  upvotes{row.upvoteCount > 0 ? ` (${row.upvoteCount})` : ""} and activity
                  history.{row.raci.length > 0 ? ` ${row.raci.length} RACI assignment${row.raci.length === 1 ? "" : "s"} will be kept but unlinked from this app.` : ""} This can't be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(false)}>
                Keep app
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={confirmDelete}
                disabled={deleteApp.isPending}
                data-testid="button-confirm-delete-app"
              >
                {deleteApp.isPending ? "Deleting..." : "Delete app"}
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmingDelete(true)}
              data-testid="button-delete-app"
            >
              <Trash2 className="h-4 w-4 mr-1.5" /> Delete app
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={save} disabled={update.isPending || renameApp.isPending}>
                {update.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportIssueDialog({ row }: { row: BoardRow }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const report = useReportIssue();

  const submit = () => {
    if (!comment.trim()) return;
    report.mutate(
      { id: row.applicationId, data: { comment: comment.trim() } },
      {
        onSuccess: () => {
          invalidateBoard(queryClient);
          setOpen(false);
          setComment("");
          toast({ title: "Issue reported", description: `Thanks — the team will look at ${row.appName}.` });
        },
        onError: (err: any) =>
          toast({ title: "Could not report issue", description: err?.data?.message ?? "Try again.", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Report issue for ${row.appName}`}>
          <Flag className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Report an issue — {row.appName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>What's wrong?</Label>
          <Textarea
            value={comment}
            rows={4}
            placeholder="Describe the rostering or data-sharing problem..."
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!comment.trim() || report.isPending}>
            {report.isPending ? "Submitting..." : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The custom rostering programs whose sections/enrollments are managed
// outside Clever; offered as one-click choices when manually adding an app.
const CUSTOM_ROSTERING_PROGRAMS = ["VLA", "PLA", "HS", "OakSchool", "MTSS", "Sped"];

function AddAppDialog({ termId }: { termId: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [owner, setOwner] = useState<string>(NO_OWNER);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createApp = useCreateApp();
  const { data: userOptions = [] } = useListUserOptions();

  const reset = () => {
    setName("");
    setCategory("");
    setNotes("");
    setOwner(NO_OWNER);
  };

  const pickProgram = (program: string) => {
    setName(program);
    setCategory(`Custom Rostering — ${program}`);
  };

  const submit = () => {
    if (!name.trim()) return;
    createApp.mutate(
      {
        data: {
          name: name.trim(),
          termId,
          category: category.trim() || null,
          owner: owner === NO_OWNER ? null : owner,
          notes: notes.trim() || null,
        },
      },
      {
        onSuccess: (res) => {
          invalidateBoard(queryClient);
          setOpen(false);
          reset();
          toast({
            title: "App added",
            description: `${res.name} is now on this term's board.`,
          });
        },
        onError: (err: any) =>
          toast({
            title: "Could not add app",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-add-app">
          <PlusCircle className="h-4 w-4 mr-1.5" /> Add app
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an app manually</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          For apps that aren't imported from Clever — like the custom rostering
          programs. The app is added to the currently selected term's board.
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Custom rostering programs</Label>
            <div className="flex flex-wrap gap-1.5">
              {CUSTOM_ROSTERING_PROGRAMS.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={name === p ? "default" : "outline"}
                  onClick={() => pickProgram(p)}
                  data-testid={`button-program-${p}`}
                >
                  {p}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Click a program to fill in the fields, or type your own below.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-app-name">Name</Label>
            <Input
              id="add-app-name"
              value={name}
              placeholder="e.g. VLA"
              onChange={(e) => setName(e.target.value)}
              data-testid="input-app-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-app-category">Category / program label</Label>
            <Input
              id="add-app-category"
              value={category}
              placeholder="e.g. Custom Rostering — VLA"
              onChange={(e) => setCategory(e.target.value)}
              data-testid="input-app-category"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Owner</Label>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger><SelectValue placeholder="Who is responsible?" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OWNER}>
                  <span className="text-muted-foreground">No owner</span>
                </SelectItem>
                {userOptions.map((u) => (
                  <SelectItem key={u.id} value={u.displayName}>
                    {u.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-app-notes">Notes</Label>
            <Textarea
              id="add-app-notes"
              value={notes}
              rows={2}
              placeholder="Optional — e.g. sections and enrollments handled by our custom rostering"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!name.trim() || createApp.isPending}
            data-testid="button-add-app-submit"
          >
            {createApp.isPending ? "Adding..." : "Add app"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TermAdminDialog({ terms }: { terms: Term[] }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createTerm = useCreateTerm();
  const updateTerm = useUpdateTerm();
  const copyStatuses = useCopyTermStatuses();

  const [label, setLabel] = useState("");
  const [schoolYear, setSchoolYear] = useState("");
  const [termType, setTermType] = useState<"regular" | "summer">("regular");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [copyTarget, setCopyTarget] = useState<string>("");
  const [copySource, setCopySource] = useState<string>("");

  const onError = (err: any) =>
    toast({ title: "Action failed", description: err?.data?.message ?? "Try again.", variant: "destructive" });

  const addTerm = () => {
    if (!label || !schoolYear || !startDate || !endDate) return;
    const maxSort = Math.max(0, ...terms.map((t) => t.sortOrder));
    createTerm.mutate(
      { data: { label, schoolYear, termType, startDate, endDate, sortOrder: maxSort + 1 } },
      {
        onSuccess: () => {
          invalidateBoard(queryClient);
          setLabel(""); setSchoolYear(""); setStartDate(""); setEndDate("");
          toast({ title: "Term added" });
        },
        onError,
      },
    );
  };

  const copy = () => {
    if (!copyTarget || !copySource || copyTarget === copySource) return;
    copyStatuses.mutate(
      { id: Number(copyTarget), data: { sourceTermId: Number(copySource) } },
      {
        onSuccess: (res: any) => {
          invalidateBoard(queryClient);
          toast({ title: "Statuses copied", description: res?.message });
        },
        onError,
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="h-4 w-4 mr-1.5" /> Manage terms
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage terms</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Current term</h4>
            <div className="flex flex-wrap gap-1.5">
              {terms.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={t.isCurrent ? "default" : "outline"}
                  disabled={updateTerm.isPending}
                  onClick={() =>
                    !t.isCurrent &&
                    updateTerm.mutate(
                      { id: t.id, data: { isCurrent: true } },
                      { onSuccess: () => invalidateBoard(queryClient), onError },
                    )
                  }
                >
                  {t.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Click a term to make it the current term.</p>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">Copy statuses between terms</h4>
            <div className="flex items-center gap-2">
              <Select value={copySource} onValueChange={setCopySource}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="From term" /></SelectTrigger>
                <SelectContent>
                  {terms.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground text-sm">to</span>
              <Select value={copyTarget} onValueChange={setCopyTarget}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="To term" /></SelectTrigger>
                <SelectContent>
                  {terms.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={copy} disabled={copyStatuses.isPending || !copySource || !copyTarget || copySource === copyTarget}>
                Copy
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">Add a term</h4>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Label (e.g. 2027-28 Regular)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <Input placeholder="School year (e.g. 2027-28)" value={schoolYear} onChange={(e) => setSchoolYear(e.target.value)} />
              <Select value={termType} onValueChange={(v) => setTermType(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="regular">Regular</SelectItem>
                  <SelectItem value="summer">Summer</SelectItem>
                </SelectContent>
              </Select>
              <div />
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <Button size="sm" onClick={addTerm} disabled={createTerm.isPending || !label || !schoolYear || !startDate || !endDate}>
              {createTerm.isPending ? "Adding..." : "Add term"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "appName" | "upvotes" | "updated";

export default function Rostering() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { options: statusOptions, meta: statusMeta } = useStatusOptions();

  const { data: terms } = useListTerms();
  const sortedTerms = useMemo(
    () => [...(terms ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [terms],
  );
  const [storedTermId, setStoredTermId] = useStoredId("sageoak-rostering-term");
  const [selectedTermIdState, setSelectedTermIdState] = useState<number | null>(null);
  const setSelectedTermId = (id: number) => {
    setSelectedTermIdState(id);
    setStoredTermId(id);
  };
  const validStoredTermId =
    storedTermId != null && sortedTerms.some((t) => t.id === storedTermId)
      ? storedTermId
      : null;
  const termId =
    selectedTermIdState ??
    validStoredTermId ??
    sortedTerms.find((t) => t.isCurrent)?.id ??
    sortedTerms[0]?.id;

  const { data: board, isLoading } = useGetRosteringBoard(
    { termId: termId as number },
    { query: { enabled: termId != null } as any },
  );
  const { data: summary } = useGetRosteringSummary(
    { termId: termId as number },
    { query: { enabled: termId != null } as any },
  );
  const upvote = useToggleUpvote();

  const [storedStatusFilter, setStatusFilter] = useStoredValue<string>(
    "sageoak-rostering-status",
    "all",
    (raw) => (raw.length > 0 ? raw : null),
  );
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useStoredValue<SortKey>(
    "sageoak-rostering-sort",
    "appName",
    oneOf(["appName", "upvotes", "updated"] as const),
  );
  const [openIssuesOnly, setOpenIssuesOnly] = useStoredValue<boolean>(
    "sageoak-rostering-open-issues",
    false,
    parseBool,
  );
  const [dayOneOnly, setDayOneOnly] = useStoredValue<boolean>(
    "sageoak-rostering-day-one",
    false,
    parseBool,
  );
  // A stored status that no longer exists (option removed/renamed) falls
  // back to "all" instead of silently filtering everything out.
  const statusFilter =
    storedStatusFilter === "all" ||
    statusOptions.length === 0 ||
    statusOptions.some((o) => o.value === storedStatusFilter)
      ? storedStatusFilter
      : "all";

  const rows = useMemo(() => {
    let out = [...(board ?? [])];
    if (statusFilter !== "all") {
      out = out.filter(
        (r) => r.studentSharingStatus === statusFilter || r.staffSharingStatus === statusFilter,
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (r) =>
          r.appName.toLowerCase().includes(q) ||
          (r.category ?? "").toLowerCase().includes(q) ||
          (r.owner ?? "").toLowerCase().includes(q),
      );
    }
    if (openIssuesOnly) out = out.filter((r) => r.openIssueCount > 0);
    if (dayOneOnly) out = out.filter((r) => r.dayOneCritical);
    out.sort((a, b) => {
      if (sortKey === "upvotes") return b.upvoteCount - a.upvoteCount;
      if (sortKey === "updated")
        return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      return a.appName.localeCompare(b.appName);
    });
    return out;
  }, [board, statusFilter, search, sortKey, openIssuesOnly, dayOneOnly]);

  // Column-header sorting layered on top of the dropdown sort — when no
  // header is active, the dropdown order above is preserved.
  const {
    sorted: displayRows,
    sort: colSort,
    toggle: toggleColSort,
  } = useTableSort(rows, boardColumnAccessors);

  const toggleUpvote = (row: BoardRow) =>
    upvote.mutate(
      { id: row.applicationId },
      {
        onSuccess: () => invalidateBoard(queryClient),
        onError: (err: any) =>
          toast({ title: "Upvote failed", description: err?.data?.message ?? "Try again.", variant: "destructive" }),
      },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-bold tracking-tight">Rostering Status Board</h2>
        <div className="flex items-center gap-2">
          {isAdmin && <ArchiveDialog />}
          {isAdmin && sortedTerms.length > 0 && <TermAdminDialog terms={sortedTerms} />}
          {isAdmin && termId != null && <AddAppDialog termId={termId} />}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sortedTerms.map((t) => {
          const rel = termRelativeLabel(t, sortedTerms);
          return (
            <Button
              key={t.id}
              size="sm"
              variant={t.id === termId ? "default" : "outline"}
              onClick={() => setSelectedTermId(t.id)}
            >
              {t.label}
              {rel && <span className="ml-1.5 text-xs opacity-70">({rel})</span>}
            </Button>
          );
        })}
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: "Applications", value: summary.total, cls: "" },
            { label: "Not started", value: summary.notStarted, cls: "text-muted-foreground" },
            { label: "In progress", value: summary.inProgress, cls: "text-amber-600 dark:text-amber-400" },
            { label: "Complete", value: summary.complete, cls: "text-emerald-600 dark:text-emerald-400" },
            { label: "Needs review", value: summary.needsReview, cls: "text-red-600 dark:text-red-400" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
                <div className={`text-xl font-bold tabular-nums ${s.cls}`}>{s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {termId != null && <RecentActivity termId={termId} />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search apps, category, owner..."
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statusOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="appName">Sort: Name</SelectItem>
            <SelectItem value="upvotes">Sort: Most upvoted</SelectItem>
            <SelectItem value="updated">Sort: Recently updated</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <Checkbox
            checked={openIssuesOnly}
            onCheckedChange={(v) => setOpenIssuesOnly(v === true)}
          />
          Open issues only
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <Checkbox
            checked={dayOneOnly}
            onCheckedChange={(v) => setDayOneOnly(v === true)}
            data-testid="checkbox-day-one-only"
          />
          Day 1 critical only
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {board && board.length > 0
              ? "No applications match the current filters."
              : "No applications on this term's board yet. Apps are added automatically from usage uploads, or copy statuses from another term."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Application" sortKey="appName" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Student sharing" sortKey="studentSharingStatus" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Staff sharing" sortKey="staffSharingStatus" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Sync" sortKey="syncMethod" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Owner" sortKey="owner" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Notes" sortKey="notes" sort={colSort} onToggle={toggleColSort} />
                  <SortableHead label="Updated" sortKey="updatedAt" sort={colSort} onToggle={toggleColSort} firstDir="desc" />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayRows.map((row) => (
                  <TableRow key={row.applicationId}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{row.appName}</span>
                        {row.dayOneCritical && (
                          <Badge
                            className="shrink-0 border-transparent bg-orange-100 text-orange-900 hover:bg-orange-100 dark:bg-orange-900/40 dark:text-orange-200"
                            title="Critically needed for day one of the school year"
                            data-testid={`badge-day-one-${row.applicationId}`}
                          >
                            Day 1
                          </Badge>
                        )}
                        {isRecent(row.updatedAt) && (
                          <span
                            className="h-2 w-2 rounded-full bg-amber-500 shrink-0"
                            title="Changed in the last 3 days"
                            aria-label="Changed recently"
                          />
                        )}
                      </div>
                      {row.category && (
                        <div className="text-xs text-muted-foreground">{row.category}</div>
                      )}
                      <RaciChips people={row.raci} applicationId={row.applicationId} />
                    </TableCell>
                    <TableCell><StatusBadge status={row.studentSharingStatus} meta={statusMeta} /></TableCell>
                    <TableCell><StatusBadge status={row.staffSharingStatus} meta={statusMeta} /></TableCell>
                    <TableCell className="text-sm">
                      {row.syncMethod ?? <span className="text-muted-foreground">—</span>}
                      {row.lastSyncedAt && (
                        <div className="text-xs text-muted-foreground">synced {row.lastSyncedAt}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.owner ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm max-w-56">
                      <span className="line-clamp-2">{row.notes ?? <span className="text-muted-foreground">—</span>}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {row.updatedAt ? (
                        <>
                          {new Date(row.updatedAt).toLocaleDateString()}
                          {row.updatedByName && <div>{row.updatedByName}</div>}
                        </>
                      ) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          size="sm"
                          variant={row.upvotedByMe ? "default" : "ghost"}
                          className="gap-1 px-2"
                          onClick={() => toggleUpvote(row)}
                          aria-label={`Upvote ${row.appName}`}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                          <span className="tabular-nums">{row.upvoteCount}</span>
                        </Button>
                        <div className="relative">
                          <ReportIssueDialog row={row} />
                          {row.openIssueCount > 0 && (
                            <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] flex items-center justify-center">
                              {row.openIssueCount}
                            </span>
                          )}
                        </div>
                        {isAdmin && termId != null && (
                          <EditStatusDialog row={row} termId={termId} />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
