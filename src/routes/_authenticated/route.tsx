import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { LayoutDashboard, Calendar, FileText, MessageSquare, LogOut, Sparkles, Notebook, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/login" });
  },
  component: AuthedLayout,
});

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/exams", label: "Exams", icon: Calendar },
  { to: "/notes", label: "Notes", icon: Notebook },
  { to: "/documents", label: "Library", icon: FileText },
  { to: "/chat", label: "General Assistant", icon: MessageSquare },
] as const;

function AuthedLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/login" });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="hidden w-64 flex-col gradient-hero p-5 text-sidebar-foreground md:flex">
        <Link to="/dashboard" className="mb-8 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gold">
            <Sparkles className="h-4 w-4 text-gold-foreground" />
          </div>
          <span className="font-display text-xl font-semibold">Scholaria</span>
        </Link>
        <nav className="flex-1 space-y-1">
          {NAV.map(({ to, label, icon: Icon }) => {
            const active = location.pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? "bg-sidebar-accent text-gold font-medium"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border pt-4 space-y-1">
          <div className="mb-2 truncate text-xs text-sidebar-foreground/60">{user?.email}</div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-card px-4 py-3 md:hidden">
          <Link to="/dashboard" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="font-display font-semibold">Scholaria</span>
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <div className="relative h-4 w-4">
                <Sun className={`h-4 w-4 absolute inset-0 transition-all duration-300 ${theme === 'dark' ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'}`} />
                <Moon className={`h-4 w-4 absolute inset-0 transition-all duration-300 ${theme === 'light' ? 'rotate-0 scale-100 opacity-100' : 'rotate-90 scale-0 opacity-0'}`} />
              </div>
            </button>
            <button onClick={signOut} className="text-sm text-muted-foreground">
              Sign out
            </button>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-2 md:hidden">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs"
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 overflow-y-auto relative">
          {/* Desktop theme toggle — top right of main content */}
          <div className="hidden md:flex sticky top-0 z-20 justify-end px-6 py-3">
            <button
              onClick={toggleTheme}
              className="flex h-9 w-9 items-center justify-center rounded-xl border bg-card text-muted-foreground hover:bg-muted hover:text-foreground transition-all duration-300 shadow-sm hover:shadow-md"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <div className="relative h-4 w-4">
                <Sun className={`h-4 w-4 absolute inset-0 transition-all duration-300 ${theme === 'dark' ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'}`} />
                <Moon className={`h-4 w-4 absolute inset-0 transition-all duration-300 ${theme === 'light' ? 'rotate-0 scale-100 opacity-100' : 'rotate-90 scale-0 opacity-0'}`} />
              </div>
            </button>
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
