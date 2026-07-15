import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/components/auth/AuthProvider";
import { Login } from "@/pages/Login";
import NotFound from "@/pages/not-found";
import Overview from "@/pages/Overview";
import Rostering from "@/pages/Rostering";
import Issues from "@/pages/Issues";
import Upload from "@/pages/Upload";
import Users from "@/pages/Users";

const queryClient = new QueryClient();

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, isAdmin } = useAuth();
  const [location, setLocation] = useLocation();

  if (!user) {
    return <Login />;
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="font-bold text-lg text-primary cursor-pointer" onClick={() => setLocation("/")}>
              Sage Oak
            </h1>
            <nav className="flex items-center space-x-1">
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/")}
              >
                Overview
              </button>
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/rostering" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/rostering")}
              >
                Rostering
              </button>
              <button 
                className={`px-3 py-2 rounded-md text-sm font-medium ${location === "/issues" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
                onClick={() => setLocation("/issues")}
              >
                Issues
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
        <Route path="/issues" component={Issues} />
        <Route path="/upload">{() => <AdminRoute component={Upload} />}</Route>
        <Route path="/users">{() => <AdminRoute component={Users} />}</Route>
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
