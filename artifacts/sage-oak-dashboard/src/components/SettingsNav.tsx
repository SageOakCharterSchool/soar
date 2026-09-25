import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";

const sections = [
  { key: "general", label: "General", path: "/settings" },
  { key: "upload", label: "Upload data", path: "/settings/upload" },
  { key: "users", label: "Users", path: "/settings/users" },
] as const;

export function SettingsNav() {
  const [location, setLocation] = useLocation();

  return (
    <nav
      aria-label="Settings sections"
      className="flex flex-wrap gap-1 border-b border-border pb-2"
    >
      {sections.map((section) => {
        const active = location === section.path;
        return (
          <Button
            key={section.key}
            type="button"
            size="sm"
            variant={active ? "secondary" : "ghost"}
            onClick={() => setLocation(section.path)}
            aria-current={active ? "page" : undefined}
            data-testid={`settings-nav-${section.key}`}
          >
            {section.label}
          </Button>
        );
      })}
    </nav>
  );
}