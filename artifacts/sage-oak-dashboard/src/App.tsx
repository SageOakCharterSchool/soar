import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  useGetRosteringUnseenCount,
  getGetRosteringUnseenCountQueryKey,
  useGetIssuesUnseenCount,
  getGetIssuesUnseenCountQueryKey,
  useGetPublicAppSettings,
} from "@workspace/api-client-react";
import { useActivityEventRefresh } from "@/hooks/useActivityEventRefresh";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { SyncAlertBanner } from "@/components/SyncAlertBanner";
import { Login } from "@/pages/Login";
import NotFound from "@/pages/not-found";
import Overview from "@/pages/Overview";
import Rostering from "@/pages/Rostering";
import Raci from "@/pages/Raci";
import Issues from "@/pages/Issues";
import Upload from "@/pages/Upload";
import Users from "@/pages/Users";
import SettingsPage from "@/pages/SettingsPage";

/** Convert "#rrggbb" to the "H S% L%" triple used by the theme variables. */
function hexToHslTriple(hex: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const H = Math.round(h * 360);
  const S = Math.round(s * 100);
  const L = Math.round(l * 100);
  return `${H} ${S}% ${L}%`;
}

/** Apply the admin-configured accent color to the theme CSS variables. */
function useAccentColor(accentColor: string | null | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    const vars = ["--primary", "--ring", "--sidebar-primary"];
    const triple = accentColor ? hexToHslTriple(accentColor) : null;
    if (triple) {
      for (const v of vars) root.style.setProperty(v, triple);
      // Slightly darker border variant.
      const darker = accentColor ? hexToHslTriple(accentColor) : null;
      if (darker) {
        const [h, s, l] = darker.split(" ");
        const lNum = Math.max(0, parseInt(l ?? "0", 10) - 7);
        root.style.setProperty("--primary-border", `${h} ${s} ${lNum}%`);
      }
    } else {
      for (const v of [...vars, "--primary-border"]) root.style.removeProperty(v);
    }
    return () => {
      for (const v of [...vars, "--primary-border"]) root.style.removeProperty(v);
    };
  }, [accentColor]);
}

const queryClient = new QueryClient();

const UNSEEN_QUERY_OPTIONS = {
  query: {
    // Slow polling remains as a fallback; live updates arrive over SSE below.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  } as any,
};

function NavBadge({
  count,
  active,
  testId,
  label,
}: {
  count: number;
  active: boolean;
  testId: string;
  label: string;
}) {
  if (active || count <= 0) return null;
  return (
    <span
      className="ml-1.5 inline-flex items-center justify-center min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-primary text-primary-foreground text-[0.65rem] font-semibold leading-none"
      data-testid={testId}
      aria-label={`${count} new ${label} ${count === 1 ? "update" : "updates"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RosteringNavBadge({ active }: { active: boolean }) {
  const { data } = useGetRosteringUnseenCount(UNSEEN_QUERY_OPTIONS);
  useActivityEventRefresh(getGetRosteringUnseenCountQueryKey());
  return (
    <NavBadge
      count={data?.count ?? 0}
      active={active}
      testId="badge-rostering-unseen"
      label="rostering"
    />
  );
}

function IssuesNavBadge({ active }: { active: boolean }) {
  const { data } = useGetIssuesUnseenCount(UNSEEN_QUERY_OPTIONS);
  useActivityEventRefresh(getGetIssuesUnseenCountQueryKey());
  return (
    <NavBadge
      count={data?.count ?? 0}
      active={active}
      testId="badge-issues-unseen"
      label="issues"
    />
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, isAdmin } = useAuth();
  const [location, setLocation] = useLocation();
  const { data: settings } = useGetPublicAppSettings({
    query: { enabled: !!user } as any,
  });
  useAccentColor(settings?.branding.accentColor);

  if (!user) {
    return <Login />;
  }

  const appName = settings?.branding.appName ?? "Sage Oak";
  const logoDataUrl = settings?.branding.logoDataUrl ?? null;
  const bannerEnabled = settings?.syncFailureBannerEnabled !== false;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1
              className="font-bold text-lg text-primary cursor-pointer inline-flex items-center gap-2"
              onClick={() => setLocation("/")}
              data-testid="text-app-name"
            >
              {logoDataUrl && (
                <img
                  src={logoDataUrl}
                  alt=""
                  className="h-7 w-7 rounded object-contain"
                  data-testid="img-app-logo"
                />
              )}
              {appName}
            </h1>
            <nav className="flex items-center space-x-1">
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/")}
              >
                Overview
              </button>
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium inline-flex items-center ${location === "/rostering" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/rostering")}
              >
                Rostering
                <RosteringNavBadge active={location === "/rostering"} />
              </button>
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/raci" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/raci")}
              >
                RACI
              </button>
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium inline-flex items-center ${location === "/issues" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/issues")}
              >
                Issues
                <IssuesNavBadge active={location === "/issues"} />
              </button>
              {isAdmin && (
                <>
                  <button 
                    className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/upload" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                    onClick={() => setLocation("/upload")}
                  >
                    Upload
                  </button>
                  <button 
                    className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/users" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                    onClick={() => setLocation("/users")}
                  >
                    Users
                  </button>
                  <button
                    className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/settings" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                    onClick={() => setLocation("/settings")}
                    data-testid="link-settings"
                  >
                    Settings
                  </button>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-right">
              <div className="font-medium">{user.displayName}</div>
              <div className="text-xs text-muted-foreground capitalize">{user.role}</div>
            </div>
            <button onClick={logout} className="text-sm text-muted-foreground hover:text-foreground">
              Sign out
            </button>
          </div>
        </div>
      </header>
      {isAdmin && bannerEnabled && <SyncAlertBanner />}
      <main className="flex-1 p-4 container mx-auto">
        {children}
      </main>
    </div>
  );
}

function AdminRoute({ component: Component }: { component: () => React.ReactElement }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <NotFound />;
  return <Component />;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/rostering" component={Rostering} />
        <Route path="/raci" component={Raci} />
        <Route path="/issues" component={Issues} />
        <Route path="/upload">{() => <AdminRoute component={Upload} />}</Route>
        <Route path="/users">{() => <AdminRoute component={Users} />}</Route>
        <Route path="/settings">{() => <AdminRoute component={SettingsPage} />}</Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
        </AuthProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
