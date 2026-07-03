import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const wrapperClassName = String(className || "")
    .split(/\s+/)
    .filter((item) => item.startsWith("w-") || item.startsWith("min-w-") || item.startsWith("max-w-"))
    .join(" ");

  return (
    <div className={cn("relative w-full", wrapperClassName)}>
      <select
        className={cn(
          "h-10 w-full appearance-none rounded-md border border-slate-300 bg-white px-3 pr-9 text-[14px] text-slate-800 outline-none transition duration-200 hover:border-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-900",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
    </div>
  );
}
