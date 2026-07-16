import { Router, type IRouter } from "express";
import { UpdateAppSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import {
  readAppSettings,
  validateSettingsUpdate,
  applySettingsUpdate,
} from "../lib/appSettings";

const router: IRouter = Router();

router.get("/settings", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await readAppSettings());
});

// Minimal subset needed by every signed-in user (branding, dropdown options,
// banner toggle). Never exposes sync schedule or notification recipients.
router.get("/settings/public", requireAuth, async (_req, res): Promise<void> => {
  const settings = await readAppSettings();
  res.json({
    staleOpenDays: settings.staleOpenDays,
    sharingStatusOptions: settings.sharingStatusOptions,
    raciValueOptions: settings.raciValueOptions,
    branding: settings.branding,
    syncFailureBannerEnabled: settings.notifications.syncFailureBannerEnabled,
  });
});

router.put("/settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateAppSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid settings payload" });
    return;
  }
  const error = validateSettingsUpdate(parsed.data);
  if (error) {
    res.status(400).json({ message: error });
    return;
  }
  await applySettingsUpdate(parsed.data);
  res.json(await readAppSettings());
});

export default router;
