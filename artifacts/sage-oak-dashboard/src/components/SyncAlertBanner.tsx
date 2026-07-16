import { useGetSyncAlerts, useDismissSyncAlert } from "@workspace/api-client-react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Red banner shown to admins on every page while the automatic Clever SFTP
 * sync has unresolved failures. Alerts clear automatically after a successful
 * sync, or can be dismissed manually.
 */
export function SyncAlertBanner() {
  const { data: alerts, refetch } = useGetSyncAlerts({
    query: { queryKey: ["getSyncAlerts"], refetchInterval: 5 * 60 * 1000 },
  });
  const dismiss = useDismissSyncAlert();

  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="bg-destructive/10 border-b border-destructive/30">
      <div className="container mx-auto px-4 py-2 space-y-1">
        {alerts.map((alert) => (
          <div key={alert.id} className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <span className="font-medium">Clever sync failed:</span> {alert.message}
              <span className="text-destructive/80">
                {" "}
                — last at {new Date(alert.lastSeenAt).toLocaleString()}
                {alert.occurrences > 1 ? ` (${alert.occurrences} times since ${new Date(alert.firstSeenAt).toLocaleString()})` : ""}
              </span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
              aria-label="Dismiss alert"
              disabled={dismiss.isPending}
              onClick={() =>
                dismiss.mutate(
                  { id: alert.id },
                  { onSuccess: () => void refetch() },
                )
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
