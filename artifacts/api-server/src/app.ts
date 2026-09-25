import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { buildSessionMiddleware } from "./lib/auth";

const app: Express = express();

// Behind a proxy (Railway / Replit) — required for secure cookies.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The web app is served from the same origin as the API, so no CORS is
// needed in production. In development, the Vite dev server may sit on a
// different origin, so allow credentialed CORS there only.
if (process.env.NODE_ENV !== "production") {
  app.use(cors({ credentials: true, origin: true }));
}

// CSRF guard: session cookies use SameSite=None in production (required for
// iframe embedding), so reject state-changing requests whose Origin header
// does not match the request host.
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    const requestHost = req.headers.host;
    if (process.env.NODE_ENV === "production" && originHost !== requestHost) {
      res.status(403).json({ message: "Cross-origin request rejected" });
      return;
    }
  } catch {
    res.status(403).json({ message: "Invalid Origin header" });
    return;
  }
  next();
});
// CSV uploads arrive as JSON with file text content — allow larger bodies.
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(buildSessionMiddleware());

app.use("/api", router);

// In production, serve the built web app from this same server (single
// Railway service hosts both API and frontend). SPA fallback for client-side
// routes; no frame-blocking headers so the app stays iframe-embeddable.
if (process.env.NODE_ENV === "production") {
  const candidates = [
    path.resolve(process.cwd(), "artifacts/sage-oak-dashboard/dist/public"),
    path.resolve(__dirname, "../../sage-oak-dashboard/dist/public"),
  ];
  const staticDir = candidates.find((dir) =>
    fs.existsSync(path.join(dir, "index.html")),
  );
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
    logger.info({ staticDir }, "Serving web app");
  } else {
    logger.warn(
      { candidates },
      "Web app build not found — API-only mode. Run the frontend build first.",
    );
  }
}

export default app;
