import { eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";

export interface DropdownOption {
  value: string;
  label: string;
  active: boolean;
}

export interface SyncScheduleSettings {
  enabled: boolean;
  /** HH:MM, 24-hour, server time. */
  time: string;
}

export interface BrandingSettings {
  appName: string;
  logoDataUrl: string | null;
  accentColor: string | null;
}

export interface NotificationSettings {
  syncFailureBannerEnabled: boolean;
  alertOnSyncWarnings: boolean;
  recipients: string[];
}

export interface AppSettings {
  staleOpenDays: number;
  sharingStatusOptions: DropdownOption[];
  raciValueOptions: DropdownOption[];
  syncSchedule: SyncScheduleSettings;
  branding: BrandingSettings;
  notifications: NotificationSettings;
}

export const SETTINGS_KEYS = {
  staleOpenDays: "staleOpenDays",
  sharingStatusOptions: "sharingStatusOptions",
  raciValueOptions: "raciValueOptions",
  syncSchedule: "syncSchedule",
  branding: "branding",
  notifications: "notifications",
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  staleOpenDays: 7,
  sharingStatusOptions: [
    { value: "not_started", label: "Not started", active: true },
    { value: "in_progress", label: "In progress", active: true },
    { value: "complete", label: "Complete", active: true },
    { value: "needs_review", label: "Needs review", active: true },
  ],
  raciValueOptions: [
    { value: "R", label: "Responsible", active: true },
    { value: "A", label: "Accountable", active: true },
    { value: "C", label: "Consulted", active: true },
    { value: "I", label: "Informed", active: true },
    { value: "N/A", label: "Not applicable", active: true },
  ],
  syncSchedule: { enabled: true, time: "02:00" },
  branding: { appName: "Sage Oak", logoDataUrl: null, accentColor: null },
  notifications: {
    syncFailureBannerEnabled: true,
    alertOnSyncWarnings: false,
    recipients: [],
  },
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA_URL_RE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
export const MAX_LOGO_DATA_URL_LENGTH = 400_000; // ~300 KB of image data

function isOption(o: unknown): o is DropdownOption {
  return (
    typeof o === "object" &&
    o !== null &&
    typeof (o as DropdownOption).value === "string" &&
    typeof (o as DropdownOption).label === "string" &&
    typeof (o as DropdownOption).active === "boolean"
  );
}

/**
 * Validate a dropdown option list. Returns an error message, or null when
 * the list is valid.
 */
export function validateOptionList(
  raw: unknown,
  what: string,
): string | null {
  if (!Array.isArray(raw)) return `${what} must be a list of options`;
  if (raw.length === 0) return `${what} must have at least one option`;
  if (raw.length > 50) return `${what} cannot have more than 50 options`;
  const seen = new Set<string>();
  for (const o of raw) {
    if (!isOption(o)) return `${what} contains a malformed option`;
    const value = o.value.trim();
    const label = o.label.trim();
    if (!value || value.length > 60)
      return `${what}: option values must be 1-60 characters`;
    if (!label || label.length > 80)
      return `${what}: option labels must be 1-80 characters`;
    const key = value.toLowerCase();
    if (seen.has(key)) return `${what}: option values must be unique ("${value}" appears twice)`;
    seen.add(key);
  }
  if (!raw.some((o) => o.active)) return `${what} must keep at least one active option`;
  return null;
}

function normalizeOptionList(raw: DropdownOption[]): DropdownOption[] {
  return raw.map((o) => ({
    value: o.value.trim(),
    label: o.label.trim(),
    active: o.active,
  }));
}

function parseJsonSetting<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseOptions(raw: string | undefined, fallback: DropdownOption[]): DropdownOption[] {
  const parsed = parseJsonSetting<unknown>(raw, fallback);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isOption)) {
    return fallback;
  }
  return parsed;
}

/** Read the full settings object, applying defaults for missing/bad values. */
export async function readAppSettings(): Promise<AppSettings> {
  const rows = await db
    .select({ key: appSettingsTable.key, value: appSettingsTable.value })
    .from(appSettingsTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const staleRaw = byKey.get(SETTINGS_KEYS.staleOpenDays);
  const staleParsed = staleRaw !== undefined ? parseInt(staleRaw, 10) : NaN;
  const staleOpenDays =
    Number.isInteger(staleParsed) && staleParsed >= 1 && staleParsed <= 365
      ? staleParsed
      : DEFAULT_SETTINGS.staleOpenDays;

  const scheduleRaw = parseJsonSetting<Partial<SyncScheduleSettings>>(
    byKey.get(SETTINGS_KEYS.syncSchedule),
    DEFAULT_SETTINGS.syncSchedule,
  );
  const syncSchedule: SyncScheduleSettings = {
    enabled:
      typeof scheduleRaw.enabled === "boolean"
        ? scheduleRaw.enabled
        : DEFAULT_SETTINGS.syncSchedule.enabled,
    time:
      typeof scheduleRaw.time === "string" && TIME_RE.test(scheduleRaw.time)
        ? scheduleRaw.time
        : DEFAULT_SETTINGS.syncSchedule.time,
  };

  const brandingRaw = parseJsonSetting<Partial<BrandingSettings>>(
    byKey.get(SETTINGS_KEYS.branding),
    DEFAULT_SETTINGS.branding,
  );
  const branding: BrandingSettings = {
    appName:
      typeof brandingRaw.appName === "string" && brandingRaw.appName.trim()
        ? brandingRaw.appName.trim()
        : DEFAULT_SETTINGS.branding.appName,
    logoDataUrl:
      typeof brandingRaw.logoDataUrl === "string" ? brandingRaw.logoDataUrl : null,
    accentColor:
      typeof brandingRaw.accentColor === "string" &&
      HEX_COLOR_RE.test(brandingRaw.accentColor)
        ? brandingRaw.accentColor
        : null,
  };

  const notifRaw = parseJsonSetting<Partial<NotificationSettings>>(
    byKey.get(SETTINGS_KEYS.notifications),
    DEFAULT_SETTINGS.notifications,
  );
  const notifications: NotificationSettings = {
    syncFailureBannerEnabled:
      typeof notifRaw.syncFailureBannerEnabled === "boolean"
        ? notifRaw.syncFailureBannerEnabled
        : DEFAULT_SETTINGS.notifications.syncFailureBannerEnabled,
    alertOnSyncWarnings:
      typeof notifRaw.alertOnSyncWarnings === "boolean"
        ? notifRaw.alertOnSyncWarnings
        : DEFAULT_SETTINGS.notifications.alertOnSyncWarnings,
    recipients: Array.isArray(notifRaw.recipients)
      ? notifRaw.recipients.filter((r): r is string => typeof r === "string")
      : DEFAULT_SETTINGS.notifications.recipients,
  };

  return {
    staleOpenDays,
    sharingStatusOptions: parseOptions(
      byKey.get(SETTINGS_KEYS.sharingStatusOptions),
      DEFAULT_SETTINGS.sharingStatusOptions,
    ),
    raciValueOptions: parseOptions(
      byKey.get(SETTINGS_KEYS.raciValueOptions),
      DEFAULT_SETTINGS.raciValueOptions,
    ),
    syncSchedule,
    branding,
    notifications,
  };
}

export async function writeSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettingsTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [appSettingsTable.key],
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Validate a partial settings update. Returns an error message for the first
 * problem found, or null when everything provided is valid.
 */
export function validateSettingsUpdate(body: {
  staleOpenDays?: unknown;
  sharingStatusOptions?: unknown;
  raciValueOptions?: unknown;
  syncSchedule?: unknown;
  branding?: unknown;
  notifications?: unknown;
}): string | null {
  if (body.staleOpenDays !== undefined) {
    const v = body.staleOpenDays;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 365) {
      return "staleOpenDays must be a whole number between 1 and 365";
    }
  }
  if (body.sharingStatusOptions !== undefined) {
    const err = validateOptionList(body.sharingStatusOptions, "Sharing status options");
    if (err) return err;
  }
  if (body.raciValueOptions !== undefined) {
    const err = validateOptionList(body.raciValueOptions, "RACI value options");
    if (err) return err;
  }
  if (body.syncSchedule !== undefined) {
    const s = body.syncSchedule as Partial<SyncScheduleSettings> | null;
    if (
      typeof s !== "object" ||
      s === null ||
      typeof s.enabled !== "boolean" ||
      typeof s.time !== "string" ||
      !TIME_RE.test(s.time)
    ) {
      return "Sync schedule needs an on/off value and a time of day in HH:MM format";
    }
  }
  if (body.branding !== undefined) {
    const b = body.branding as Partial<BrandingSettings> | null;
    if (typeof b !== "object" || b === null) return "Branding settings are malformed";
    if (
      typeof b.appName !== "string" ||
      !b.appName.trim() ||
      b.appName.trim().length > 60
    ) {
      return "App name must be 1-60 characters";
    }
    if (b.accentColor != null && !HEX_COLOR_RE.test(String(b.accentColor))) {
      return 'Accent color must be a hex color like "#4a7c67"';
    }
    if (b.logoDataUrl != null) {
      if (typeof b.logoDataUrl !== "string" || !DATA_URL_RE.test(b.logoDataUrl)) {
        return "Logo must be an uploaded PNG, JPEG, GIF, WebP, or SVG image";
      }
      if (b.logoDataUrl.length > MAX_LOGO_DATA_URL_LENGTH) {
        return "Logo image is too large — please use an image under 300 KB";
      }
    }
  }
  if (body.notifications !== undefined) {
    const n = body.notifications as Partial<NotificationSettings> | null;
    if (
      typeof n !== "object" ||
      n === null ||
      typeof n.syncFailureBannerEnabled !== "boolean" ||
      typeof n.alertOnSyncWarnings !== "boolean" ||
      !Array.isArray(n.recipients)
    ) {
      return "Notification settings are malformed";
    }
    if (n.recipients.length > 20) return "At most 20 alert recipients are allowed";
    for (const r of n.recipients) {
      if (typeof r !== "string" || !EMAIL_RE.test(r.trim())) {
        return `"${String(r)}" is not a valid email address`;
      }
    }
  }
  return null;
}

/**
 * Apply a validated partial update, persisting each provided section.
 */
export async function applySettingsUpdate(body: {
  staleOpenDays?: number;
  sharingStatusOptions?: DropdownOption[];
  raciValueOptions?: DropdownOption[];
  syncSchedule?: SyncScheduleSettings;
  branding?: BrandingSettings;
  notifications?: NotificationSettings;
}): Promise<void> {
  if (body.staleOpenDays !== undefined) {
    await writeSetting(SETTINGS_KEYS.staleOpenDays, String(body.staleOpenDays));
  }
  if (body.sharingStatusOptions !== undefined) {
    await writeSetting(
      SETTINGS_KEYS.sharingStatusOptions,
      JSON.stringify(normalizeOptionList(body.sharingStatusOptions)),
    );
  }
  if (body.raciValueOptions !== undefined) {
    await writeSetting(
      SETTINGS_KEYS.raciValueOptions,
      JSON.stringify(normalizeOptionList(body.raciValueOptions)),
    );
  }
  if (body.syncSchedule !== undefined) {
    await writeSetting(SETTINGS_KEYS.syncSchedule, JSON.stringify(body.syncSchedule));
  }
  if (body.branding !== undefined) {
    await writeSetting(
      SETTINGS_KEYS.branding,
      JSON.stringify({
        appName: body.branding.appName.trim(),
        logoDataUrl: body.branding.logoDataUrl ?? null,
        accentColor: body.branding.accentColor ?? null,
      }),
    );
  }
  if (body.notifications !== undefined) {
    await writeSetting(
      SETTINGS_KEYS.notifications,
      JSON.stringify({
        syncFailureBannerEnabled: body.notifications.syncFailureBannerEnabled,
        alertOnSyncWarnings: body.notifications.alertOnSyncWarnings,
        recipients: body.notifications.recipients.map((r) => r.trim()),
      }),
    );
  }
}

/** Active option values for a settings-driven dropdown. */
export async function getActiveOptionValues(
  kind: "sharingStatusOptions" | "raciValueOptions",
): Promise<string[]> {
  const settings = await readAppSettings();
  return settings[kind].filter((o) => o.active).map((o) => o.value);
}

/** Value → label map across all (including deactivated) options. */
export async function getOptionLabels(
  kind: "sharingStatusOptions" | "raciValueOptions",
): Promise<Map<string, string>> {
  const settings = await readAppSettings();
  return new Map(settings[kind].map((o) => [o.value, o.label]));
}
