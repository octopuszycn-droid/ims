import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const toneStyles = {
  success: "bg-green-50 text-green-700 ring-green-600/10 dark:bg-green-500/10 dark:text-green-300",
  warning: "bg-amber-50 text-amber-700 ring-amber-600/10 dark:bg-amber-500/10 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-500/10 dark:text-red-300",
  neutral: "bg-slate-100 text-slate-600 ring-slate-600/10 dark:bg-slate-800 dark:text-slate-300",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof toneStyles }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-1 text-[12px] font-medium ring-1 ring-inset",
        toneStyles[tone],
        className,
      )}
      {...props}
    />
  );
}
