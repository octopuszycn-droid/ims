import { Command } from "lucide-react";
import { navItems, secondaryNav } from "../data/dashboard";
import { cn } from "../lib/utils";

export function Sidebar() {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white px-4 py-5 dark:border-slate-800 dark:bg-slate-950 lg:flex lg:flex-col">
      <div className="flex h-10 items-center gap-3 px-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
          <Command className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[14px] font-semibold text-slate-950 dark:text-white">Nexus Cloud</p>
          <p className="text-[12px] text-slate-500">Enterprise Suite</p>
        </div>
      </div>

      <nav className="mt-8 space-y-1">
        {navItems.map((item) => (
          <a
            className={cn(
              "flex h-10 items-center gap-3 rounded-lg px-3 text-[14px] font-medium text-slate-600 transition duration-200 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white",
              item.active &&
                "bg-blue-50 text-blue-700 hover:bg-blue-50 hover:text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
            )}
            href="#"
            key={item.label}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </a>
        ))}
      </nav>

      <div className="mt-auto space-y-1 border-t border-slate-200 pt-4 dark:border-slate-800">
        {secondaryNav.map((item) => (
          <a
            className="flex h-10 items-center gap-3 rounded-lg px-3 text-[14px] font-medium text-slate-600 transition duration-200 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white"
            href="#"
            key={item.label}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </a>
        ))}
      </div>
    </aside>
  );
}
