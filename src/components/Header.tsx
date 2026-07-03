import { Bell, Menu, Moon, Plus, Search, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type HeaderProps = {
  isDark: boolean;
  onToggleTheme: () => void;
};

export function Header({ isDark, onToggleTheme }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90 sm:px-6">
      <Button className="lg:hidden" size="icon" variant="ghost" aria-label="Open navigation">
        <Menu className="h-5 w-5" />
      </Button>

      <div className="relative hidden w-full max-w-md sm:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input className="pl-9" placeholder="Search accounts, invoices, users..." />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Notifications">
          <Bell className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="icon" onClick={onToggleTheme} aria-label="Toggle dark mode">
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button className="hidden sm:inline-flex">
          <Plus className="h-4 w-4" />
          New Report
        </Button>
        <div className="h-9 w-9 rounded-full bg-slate-900 text-[12px] font-semibold leading-9 text-white dark:bg-white dark:text-slate-950">
          MC
        </div>
      </div>
    </header>
  );
}
