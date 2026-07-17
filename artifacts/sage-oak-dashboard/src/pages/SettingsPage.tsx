import { useEffect, useRef, useState } from "react";
import {
  useGetAppSettings,
  getGetAppSettingsQueryKey,
  getGetPublicAppSettingsQueryKey,
  useUpdateAppSettings,
  useGetSftpSyncStatus,
  getGetSftpSyncStatusQueryKey,
  useTriggerSftpSync,
  type AppSettings,
  type AppSettingsUpdate,
  type DropdownOption,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2, X } from "lucide-react";

const MAX_LOGO_BYTES = 300 * 1024;

function slugify(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "option"
  );
}

function useSaveSettings(successMessage: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateAppSettings();
  const save = (data: AppSettingsUpdate, onDone?: () => void) =>
    update.mutate(
      { data },
      {
        onSuccess: (fresh) => {
          queryClient.setQueryData(getGetAppSettingsQueryKey(), fresh);
          void queryClient.invalidateQueries({
            queryKey: getGetPublicAppSettingsQueryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: getGetSftpSyncStatusQueryKey(),
          });
          toast({ title: successMessage });
          onDone?.();
        },
        onError: (err: any) => {
          toast({
            title: "Could not save settings",
            description: err?.data?.message ?? "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  return { save, isPending: update.isPending };
}

function OptionsEditor({
  title,
  description,
  options: initial,
  valueEditableOnAdd,
}: {
  title: string;
  description: string;
  options: DropdownOption[];
  valueEditableOnAdd?: boolean;
}) {
  const [options, setOptions] = useState<DropdownOption[]>(initial);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const { save, isPending } = useSaveSettings(`${title} saved`);
  const key =
    title === "Sharing status options" ? "sharingStatusOptions" : "raciValueOptions";

  const setOption = (i: number, patch: Partial<DropdownOption>) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));

  const move = (i: number, dir: -1 | 1) =>
    setOptions((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item!);
      return next;
    });

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    const value = (valueEditableOnAdd && newValue.trim()) || slugify(label);
    if (options.some((o) => o.value.toLowerCase() === value.toLowerCase())) return;
    setOptions((prev) => [...prev, { value, label, active: true }]);
    setNewLabel("");
    setNewValue("");
  };

  return (
    <Card data-testid={`card-${key}`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {options.map((o, i) => (
            <div key={o.value} className="flex items-center gap-2">
              <Badge variant="outline" className="min-w-24 justify-center font-mono text-xs shrink-0">
                {o.value}
              </Badge>
              <Input
                value={o.label}
                onChange={(e) => setOption(i, { label: e.target.value })}
                className="h-8"
                aria-label={`Label for ${o.value}`}
                data-testid={`input-label-${key}-${o.value}`}
              />
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === options.length - 1}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <div className="flex items-center gap-1.5 shrink-0">
                <Switch
                  checked={o.active}
                  onCheckedChange={(v) => setOption(i, { active: v })}
                  aria-label={`${o.label} active`}
                  data-testid={`switch-active-${key}-${o.value}`}
                />
                <span className="text-xs text-muted-foreground w-12">
                  {o.active ? "Active" : "Hidden"}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Hidden options no longer appear in pickers, but existing records that use
          them keep their value.
        </p>
        <div className="flex items-center gap-2">
          {valueEditableOnAdd && (
            <Input
              placeholder="Value (e.g. S)"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="h-8 w-28"
              data-testid={`input-new-value-${key}`}
            />
          )}
          <Input
            placeholder="New option label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            className="h-8 max-w-xs"
            data-testid={`input-new-label-${key}`}
          />
          <Button size="sm" variant="outline" onClick={add} data-testid={`button-add-${key}`}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
          <div className="ml-auto">
            <Button
              size="sm"
              onClick={() => save({ [key]: options })}
              disabled={isPending}
              data-testid={`button-save-${key}`}
            >
              Save
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SyncScheduleCard({ settings }: { settings: AppSettings }) {
  const [enabled, setEnabled] = useState(settings.syncSchedule.enabled);
  const [time, setTime] = useState(settings.syncSchedule.time);
  const { save, isPending } = useSaveSettings("Sync schedule saved");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: sync } = useGetSftpSyncStatus({
    query: { refetchInterval: 60_000 } as any,
  });
  const trigger = useTriggerSftpSync();

  return (
    <Card data-testid="card-sync-schedule">
      <CardHeader>
        <CardTitle>Nightly Clever sync</CardTitle>
        <CardDescription>
          When enabled, reports are pulled from the Clever SFTP server once a day at
          the chosen time (server time).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Nightly sync enabled"
              data-testid="switch-sync-enabled"
            />
            <span className="text-sm">{enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="sync-time" className="text-sm">
              Run at
            </Label>
            <Input
              id="sync-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-8 w-32"
              data-testid="input-sync-time"
            />
          </div>
          <Button
            size="sm"
            onClick={() => save({ syncSchedule: { enabled, time } })}
            disabled={isPending || !/^\d{2}:\d{2}$/.test(time)}
            data-testid="button-save-sync-schedule"
          >
            Save
          </Button>
        </div>
        <div className="text-sm text-muted-foreground space-y-1">
          {sync && !sync.configured && (
            <p data-testid="text-sync-not-configured">
              SFTP is not configured on the server, so scheduled syncs will not run.
            </p>
          )}
          <p data-testid="text-next-run">
            Next scheduled run:{" "}
            {sync?.nextRunAt
              ? new Date(sync.nextRunAt).toLocaleString()
              : sync && !sync.scheduleEnabled
                ? "disabled"
                : "—"}
          </p>
          {sync?.lastRunAt && (
            <p>Last run: {new Date(sync.lastRunAt).toLocaleString()}</p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={trigger.isPending || sync?.running || !sync?.configured}
          onClick={() =>
            trigger.mutate(undefined, {
              onSuccess: () => {
                toast({ title: "Sync started" });
                void queryClient.invalidateQueries({
                  queryKey: getGetSftpSyncStatusQueryKey(),
                });
              },
              onError: (err: any) =>
                toast({
                  title: "Could not start sync",
                  description: err?.data?.message ?? "Please try again.",
                  variant: "destructive",
                }),
            })
          }
          data-testid="button-run-sync-now"
        >
          <RefreshCw className="h-4 w-4 mr-1" /> Run now
        </Button>
      </CardContent>
    </Card>
  );
}

const ACCENT_PRESETS = ["#687664", "#8d9e88", "#374f59", "#1c476c"];

function BrandingCard({ settings }: { settings: AppSettings }) {
  const [appName, setAppName] = useState(settings.branding.appName);
  const [logoDataUrl, setLogoDataUrl] = useState(settings.branding.logoDataUrl);
  const [accentColor, setAccentColor] = useState(settings.branding.accentColor);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { save, isPending } = useSaveSettings("Branding saved");

  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast({
        title: "Logo too large",
        description: "Please choose an image under 300 KB.",
        variant: "destructive",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <Card data-testid="card-branding">
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>
          Customize the app name, logo, and accent color shown across the dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5 max-w-xs">
          <Label htmlFor="brand-name">App name</Label>
          <Input
            id="brand-name"
            value={appName}
            maxLength={60}
            onChange={(e) => setAppName(e.target.value)}
            data-testid="input-app-name"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Logo</Label>
          <div className="flex items-center gap-3">
            {logoDataUrl ? (
              <img
                src={logoDataUrl}
                alt="Logo preview"
                className="h-10 w-10 rounded object-contain border border-border bg-card"
                data-testid="img-logo-preview"
              />
            ) : (
              <div className="h-10 w-10 rounded border border-dashed border-border grid place-items-center text-xs text-muted-foreground">
                —
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
              data-testid="input-logo-file"
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} data-testid="button-upload-logo">
              Upload image
            </Button>
            {logoDataUrl && (
              <Button size="sm" variant="ghost" onClick={() => setLogoDataUrl(null)} data-testid="button-remove-logo">
                <Trash2 className="h-4 w-4 mr-1" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG, JPEG, GIF, WebP, or SVG up to 300 KB.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Accent color</Label>
          <div className="flex items-center gap-2">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => setAccentColor(c)}
                className={`h-7 w-7 rounded-full border-2 ${accentColor === c ? "border-foreground" : "border-transparent"}`}
                style={{ backgroundColor: c }}
                data-testid={`button-accent-${c.slice(1)}`}
              />
            ))}
            <input
              type="color"
              value={accentColor ?? "#687664"}
              onChange={(e) => setAccentColor(e.target.value)}
              className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
              aria-label="Custom accent color"
              data-testid="input-accent-color"
            />
            {accentColor && (
              <Button size="sm" variant="ghost" onClick={() => setAccentColor(null)} data-testid="button-reset-accent">
                <X className="h-3.5 w-3.5 mr-1" /> Use default
              </Button>
            )}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => save({ branding: { appName: appName.trim(), logoDataUrl, accentColor } })}
          disabled={isPending || !appName.trim()}
          data-testid="button-save-branding"
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

function NotificationsCard({ settings }: { settings: AppSettings }) {
  const [bannerEnabled, setBannerEnabled] = useState(
    settings.notifications.syncFailureBannerEnabled,
  );
  const [alertOnWarnings, setAlertOnWarnings] = useState(
    settings.notifications.alertOnSyncWarnings,
  );
  const [recipients, setRecipients] = useState(settings.notifications.recipients);
  const [newRecipient, setNewRecipient] = useState("");
  const { save, isPending } = useSaveSettings("Notification preferences saved");

  const addRecipient = () => {
    const email = newRecipient.trim();
    if (!email || recipients.includes(email)) return;
    setRecipients((prev) => [...prev, email]);
    setNewRecipient("");
  };

  return (
    <Card data-testid="card-notifications">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Control the sync-failure banner and who should be alerted about sync
          problems.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            checked={bannerEnabled}
            onCheckedChange={setBannerEnabled}
            aria-label="Show sync failure banner"
            data-testid="switch-banner-enabled"
          />
          <span className="text-sm">Show a banner to admins when the nightly sync fails</span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={alertOnWarnings}
            onCheckedChange={setAlertOnWarnings}
            aria-label="Alert on sync warnings"
            data-testid="switch-alert-warnings"
          />
          <span className="text-sm">Also alert on sync warnings (not just failures)</span>
        </div>
        <div className="space-y-1.5">
          <Label>Alert recipients</Label>
          <div className="flex flex-wrap gap-1.5">
            {recipients.length === 0 && (
              <span className="text-xs text-muted-foreground">No recipients yet.</span>
            )}
            {recipients.map((r) => (
              <Badge key={r} variant="secondary" className="gap-1" data-testid={`badge-recipient-${r}`}>
                {r}
                <button
                  type="button"
                  aria-label={`Remove ${r}`}
                  onClick={() => setRecipients((prev) => prev.filter((x) => x !== r))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex items-center gap-2 max-w-sm">
            <Input
              type="email"
              placeholder="name@sageoak.org"
              value={newRecipient}
              onChange={(e) => setNewRecipient(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRecipient()}
              className="h-8"
              data-testid="input-new-recipient"
            />
            <Button size="sm" variant="outline" onClick={addRecipient} data-testid="button-add-recipient">
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() =>
            save({
              notifications: {
                syncFailureBannerEnabled: bannerEnabled,
                alertOnSyncWarnings: alertOnWarnings,
                recipients,
              },
            })
          }
          disabled={isPending}
          data-testid="button-save-notifications"
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetAppSettings();
  // Remount editable cards when fresh settings arrive after a save elsewhere.
  const [loadedKey, setLoadedKey] = useState(0);
  useEffect(() => {
    if (settings) setLoadedKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings === undefined]);

  if (isLoading || !settings) {
    return (
      <div className="space-y-4 max-w-3xl">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-3xl" data-testid="page-settings">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Admin-only configuration for dropdowns, syncing, branding, and alerts.
        </p>
      </div>
      <div key={loadedKey} className="space-y-4">
        <OptionsEditor
          title="Sharing status options"
          description="Statuses available in the rostering board's student and staff sharing pickers."
          options={settings.sharingStatusOptions}
        />
        <OptionsEditor
          title="RACI value options"
          description="Values available in RACI matrix cells. Short codes work best (R, A, C...)."
          options={settings.raciValueOptions}
          valueEditableOnAdd
        />
        <SyncScheduleCard settings={settings} />
        <BrandingCard settings={settings} />
        <NotificationsCard settings={settings} />
      </div>
    </div>
  );
}
