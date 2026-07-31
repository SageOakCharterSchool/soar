import { useState } from "react";
import {
  useListRequests,
  useCreateRequest,
  useUpdateRequest,
  useDeleteRequest,
  useListRaciAppOptions,
  getListRequestsQueryKey,
  type ListRequestsStatus,
  type AppRequestInputRequestType,
  type AppRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, PlusCircle } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useToast } from "@/hooks/use-toast";

const TYPE_OPTIONS: { value: AppRequestInputRequestType; label: string }[] = [
  { value: "lti_addon", label: "LTI integration / add-on" },
  { value: "nested_app", label: "Nested app under a parent app" },
  { value: "new_app", label: "Brand-new app" },
  { value: "other", label: "Other" },
];

const TYPE_LABELS = Object.fromEntries(TYPE_OPTIONS.map((t) => [t.value, t.label]));

// Types where linking a parent/existing app makes sense.
const APP_LINK_TYPES = new Set(["lti_addon", "nested_app", "other"]);

const STATUS_META: Record<
  AppRequest["status"],
  { label: string; className: string }
> = {
  new: { label: "New", className: "bg-sky-600 text-white border-transparent hover:bg-sky-600" },
  under_review: {
    label: "Under review",
    className:
      "bg-amber-100 text-amber-800 border-transparent hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300",
  },
  approved: {
    label: "Approved",
    className:
      "bg-emerald-100 text-emerald-800 border-transparent hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  completed: { label: "Completed", className: "" },
  declined: {
    label: "Declined",
    className:
      "bg-rose-100 text-rose-800 border-transparent hover:bg-rose-100 dark:bg-rose-900/40 dark:text-rose-300",
  },
};

const STATUS_ORDER: AppRequest["status"][] = [
  "new",
  "under_review",
  "approved",
  "completed",
  "declined",
];

const FILTERS: { label: string; value: ListRequestsStatus | undefined }[] = [
  { label: "New", value: "new" },
  { label: "Under review", value: "under_review" },
  { label: "Approved", value: "approved" },
  { label: "Completed", value: "completed" },
  { label: "Declined", value: "declined" },
  { label: "All", value: undefined },
];

const NO_APP = "__none__";

function NewRequestDialog() {
  const [open, setOpen] = useState(false);
  const [requestType, setRequestType] = useState<AppRequestInputRequestType>("lti_addon");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [appId, setAppId] = useState<string>(NO_APP);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createRequest = useCreateRequest();
  const { data: appOptions = [] } = useListRaciAppOptions();

  const reset = () => {
    setRequestType("lti_addon");
    setTitle("");
    setDetails("");
    setAppId(NO_APP);
  };

  const linkable = APP_LINK_TYPES.has(requestType);

  const submit = () => {
    if (!title.trim()) return;
    createRequest.mutate(
      {
        data: {
          requestType,
          title: title.trim(),
          details: details.trim() || null,
          applicationId:
            linkable && appId !== NO_APP ? parseInt(appId, 10) : null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            predicate: (q) => String(q.queryKey[0]).includes("requests"),
          });
          setOpen(false);
          reset();
          toast({
            title: "Request submitted",
            description: "It will show as New until an admin reviews it.",
          });
        },
        onError: (err: any) =>
          toast({
            title: "Could not submit request",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-new-request">
          <PlusCircle className="h-4 w-4 mr-1.5" /> New request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit a request</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Ask for an add-on (like an LTI integration for Canvas), an app nested
          under a parent app, or a brand-new app.
        </p>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>What kind of request is this?</Label>
            <Select
              value={requestType}
              onValueChange={(v) => setRequestType(v as AppRequestInputRequestType)}
            >
              <SelectTrigger data-testid="select-request-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {linkable && (
            <div className="space-y-1.5">
              <Label>Related app (optional)</Label>
              <Select value={appId} onValueChange={setAppId}>
                <SelectTrigger data-testid="select-request-app">
                  <SelectValue placeholder="Pick the parent app" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_APP}>
                    <span className="text-muted-foreground">No specific app</span>
                  </SelectItem>
                  {appOptions.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="request-title">What are you requesting?</Label>
            <Input
              id="request-title"
              value={title}
              placeholder="e.g. Canvas LTI integration for IXL"
              onChange={(e) => setTitle(e.target.value)}
              data-testid="input-request-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-details">Details</Label>
            <Textarea
              id="request-details"
              value={details}
              rows={3}
              placeholder="Optional — who needs it, links, context"
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!title.trim() || createRequest.isPending}
            data-testid="button-submit-request"
          >
            {createRequest.isPending ? "Submitting..." : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Requests() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ListRequestsStatus | undefined>(undefined);

  const { data: requests, isLoading } = useListRequests(
    status ? { status } : undefined,
  );
  const updateRequest = useUpdateRequest();
  const deleteRequest = useDeleteRequest();

  const invalidate = () =>
    queryClient.invalidateQueries({
      predicate: (q) =>
        String(q.queryKey[0]).includes("requests") ||
        String(q.queryKey[0]).includes("rostering"),
    });

  const setRequestStatus = (id: number, next: AppRequest["status"]) => {
    updateRequest.mutate(
      { id, data: { status: next } },
      {
        onSuccess: invalidate,
        onError: (err: any) =>
          toast({
            title: "Update failed",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteRequest.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Request deleted" });
        },
        onError: (err: any) =>
          toast({
            title: "Delete failed",
            description: err?.data?.message ?? "Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  // Active requests first (in lifecycle order), each group newest first.
  const sorted = [...(requests ?? [])].sort((a, b) => {
    const orderDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-bold tracking-tight">Requests</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1 flex-wrap">
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
          <NewRequestDialog />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !requests || requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No {status ? STATUS_META[status as AppRequest["status"]]?.label.toLowerCase() : ""} requests
            yet. Use "New request" to ask for an LTI add-on, a nested app, or a
            brand-new app.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sorted.map((request) => (
            <Card key={request.id} data-testid={`card-request-${request.id}`}>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{request.title}</span>
                    <Badge className={STATUS_META[request.status].className} variant="secondary">
                      {STATUS_META[request.status].label}
                    </Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      {TYPE_LABELS[request.requestType] ?? request.requestType}
                    </Badge>
                    {request.appName && (
                      <Badge variant="outline">{request.appName}</Badge>
                    )}
                  </div>
                  {request.details && <p className="text-sm">{request.details}</p>}
                  <p className="text-xs text-muted-foreground">
                    Requested by {request.requesterName} on{" "}
                    {new Date(request.createdAt).toLocaleDateString()}
                    {request.statusUpdatedAt &&
                      ` · Status updated ${new Date(request.statusUpdatedAt).toLocaleDateString()}`}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <Select
                      value={request.status}
                      onValueChange={(v) =>
                        setRequestStatus(request.id, v as AppRequest["status"])
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-[150px]"
                        disabled={updateRequest.isPending}
                        data-testid={`select-status-${request.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_ORDER.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_META[s].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label="Delete request"
                          disabled={deleteRequest.isPending}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this request?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes "{request.title}". This
                            cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleDelete(request.id)}
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
          ))}
        </div>
      )}
    </div>
  );
}
