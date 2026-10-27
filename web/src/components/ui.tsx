import clsx from "clsx";
import {
  AlignEndHorizontal,
  Ban,
  Bell,
  BookOpen,
  Calendar,
  ClipboardList,
  Clock,
  Gauge,
  Gift,
  GitBranch,
  Hand,
  Headset,
  History,
  Image,
  LifeBuoy,
  Mail,
  MessageSquare,
  Minus,
  MonitorSmartphone,
  MousePointerClick,
  Newspaper,
  Octagon,
  Phone,
  PiggyBank,
  Puzzle,
  ScanFace,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Split,
  Star,
  SquareTerminal,
  Type,
  UserCheck,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import type { Tone } from "../../../shared/types";
import { actionTypeLabel, chLabel, fmtDelta } from "../lib/format";

/** Icons named by the server (block and node catalogs). */
const ICONS: Record<string, LucideIcon> = {
  hand: Hand,
  history: History,
  "life-buoy": LifeBuoy,
  sparkles: Sparkles,
  "piggy-bank": PiggyBank,
  gauge: Gauge,
  calendar: Calendar,
  "book-open": BookOpen,
  star: Star,
  wand: Wand2,
  image: Image,
  type: Type,
  "mouse-pointer": MousePointerClick,
  minus: Minus,
  "align-bottom": AlignEndHorizontal,
  puzzle: Puzzle,
  zap: Zap,
  "git-branch": GitBranch,
  clock: Clock,
  split: Split,
  octagon: Octagon,
  scan: ScanFace,
  send: Send,
  clipboard: ClipboardList,
  gift: Gift,
  bell: Bell,
  ban: Ban,
  shield: ShieldCheck,
  "user-check": UserCheck,
  terminal: SquareTerminal,
};
export const iconFor = (name?: string): LucideIcon => (name && ICONS[name]) || Puzzle;

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("rounded-xl border border-ink-200 bg-white", className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-400">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "sun" | "violet";
export function Button({
  variant = "secondary",
  size = "md",
  className,
  icon: Icon,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-navy-900 text-white hover:bg-navy-800",
        variant === "sun" && "bg-sun-400 text-navy-950 hover:bg-sun-300",
        variant === "secondary" && "border border-ink-200 bg-white text-ink-900 hover:bg-ink-50",
        variant === "ghost" && "text-ink-700 hover:bg-ink-100",
        variant === "violet" && "bg-violet-600 text-white hover:bg-violet-600/90",
        variant === "danger" && "border border-bad-600/20 bg-bad-50 text-bad-600 hover:bg-bad-600/10",
        className,
      )}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} strokeWidth={2} />}
      {children}
    </button>
  );
}

type Tint = "neutral" | "navy" | "good" | "warn" | "bad" | "violet" | "teal" | "sun";
const tints: Record<Tint, string> = {
  neutral: "bg-ink-100 text-ink-700",
  navy: "bg-navy-100 text-navy-800",
  good: "bg-good-50 text-good-600",
  warn: "bg-warn-50 text-warn-600",
  bad: "bg-bad-50 text-bad-600",
  violet: "bg-violet-50 text-violet-600",
  teal: "bg-teal-50 text-teal-600",
  sun: "bg-sun-100 text-navy-950",
};

export function Badge({ tint = "neutral", children, className, title }: { tint?: Tint; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12px] font-medium", tints[tint], className)}
    >
      {children}
    </span>
  );
}

export function ToneBadge({ tone, source }: { tone: Tone; source?: "detected" | "default" }) {
  return (
    <Badge tint={tone === "du" ? "violet" : "navy"} title={source === "default" ? "Default (no profiling consent or no text)" : "Detected from the customer's own messages"}>
      {tone === "du" ? "Du" : "Sie"}
      {source === "default" && <span className="font-normal opacity-70">· default</span>}
    </Badge>
  );
}

const channelIcons: Record<string, LucideIcon> = {
  email: Mail,
  newsletter: Newspaper,
  portal_popup: MonitorSmartphone,
  app_push: Smartphone,
  sms: MessageSquare,
  outbound_call: Phone,
  service_contact: Headset,
};

export function ChannelChip({ channel, muted }: { channel: string; muted?: boolean }) {
  const Icon = channelIcons[channel] ?? Bell;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]", muted ? "text-ink-400" : "text-ink-700")}>
      <Icon size={14} strokeWidth={2} />
      {chLabel(channel)}
    </span>
  );
}

export function ActionTypeBadge({ type }: { type: string }) {
  const tint: Record<string, Tint> = { sales: "navy", upsell: "teal", retention: "sun", one_off: "neutral", service: "good" };
  return <Badge tint={tint[type] ?? "neutral"}>{actionTypeLabel[type] ?? type}</Badge>;
}

export function Delta({ value, className }: { value: number; className?: string }) {
  return (
    <span className={clsx("num font-semibold", value > 0 ? "text-good-600" : value < 0 ? "text-bad-600" : "text-ink-500", className)}>
      {fmtDelta(value)}
    </span>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone = "neutral",
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "navy";
  icon?: LucideIcon;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-500">{label}</span>
        {Icon && (
          <span
            className={clsx(
              "grid h-7 w-7 place-items-center rounded-lg",
              tone === "good" && "bg-good-50 text-good-600",
              tone === "warn" && "bg-warn-50 text-warn-600",
              tone === "bad" && "bg-bad-50 text-bad-600",
              tone === "navy" && "bg-navy-100 text-navy-800",
              tone === "neutral" && "bg-ink-100 text-ink-700",
            )}
          >
            <Icon size={15} strokeWidth={2} />
          </span>
        )}
      </div>
      <div className="num mt-2 text-[26px] font-semibold leading-none tracking-tight text-ink-950">{value}</div>
      {hint && <div className="mt-2 text-[12.5px] text-ink-500">{hint}</div>}
    </Card>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-navy-900" : "bg-ink-300",
      )}
    >
      <span className={clsx("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  id,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink-200 accent-navy-900"
    />
  );
}

export function Empty({ title, hint, icon: Icon }: { title: string; hint?: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {Icon && (
        <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-ink-100 text-ink-500">
          <Icon size={18} />
        </span>
      )}
      <div className="text-sm font-medium text-ink-900">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-[13px] text-ink-500">{hint}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("shimmer rounded-md", className)} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-ink-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
            value === o.value ? "bg-navy-900 text-white" : "text-ink-600 hover:bg-ink-50",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-500">{label}</div>
      <div className="num mt-0.5 text-[15px] font-semibold text-ink-900">{children}</div>
    </div>
  );
}

// ---------- Desktop shell pieces ----------

/** Title bar of a page: doubles as the window drag region in the desktop build. */
export function PageBar({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="drag flex h-14 shrink-0 items-center justify-between gap-4 border-b border-ink-200/80 bg-white/70 px-6 backdrop-blur">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink-950">{title}</h1>
        {subtitle && <div className="truncate text-[12px] text-ink-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Right-hand detail panel, like an inspector in a desktop app. */
export function Sheet({ open, onClose, title, children, width = 480 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  return (
    <>
      <div className={clsx("fixed inset-0 z-[45] bg-ink-950/10 transition-opacity", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={onClose} />
      <aside
        style={{ width }}
        className={clsx(
          "fixed inset-y-0 right-0 z-[46] flex max-w-full flex-col border-l border-ink-200 bg-white transition-transform duration-200",
          open ? "translate-x-0 shadow-2xl" : "invisible translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-ink-100 px-5">
          <div className="min-w-0 truncate text-[14px] font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-[12.5px] text-ink-500 hover:bg-ink-100" aria-label="Close panel">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">{open && children}</div>
      </aside>
    </>
  );
}

/** Underlined tabs for switching views inside one screen. */
export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-5 border-b border-ink-200">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "-mb-px border-b-2 pb-2 text-[13px] font-medium transition-colors",
            value === o.value ? "border-navy-900 text-ink-950" : "border-transparent text-ink-500 hover:text-ink-800",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="num ml-1.5 text-ink-400">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Large number with a small label, used in a single row instead of KPI card grids. */
export function Figure({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="min-w-0">
      <div className={clsx("num text-[22px] font-semibold leading-tight tracking-tight", tone === "good" ? "text-good-600" : tone === "bad" ? "text-bad-600" : tone === "warn" ? "text-warn-600" : "text-ink-950")}>
        {value}
      </div>
      <div className="mt-0.5 text-[12px] text-ink-500">{label}</div>
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <h2 className="text-[12px] font-semibold uppercase tracking-wider text-ink-400">{children}</h2>
      {action}
    </div>
  );
}

// ---------- Form controls ----------

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 block text-[12px] font-medium text-ink-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-400">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] text-ink-900 placeholder:text-ink-400 focus:border-navy-700 focus:outline-none focus:ring-2 focus:ring-navy-100";

/** Base input classes, without the full width when the caller sets its own width. */
const baseCls = (className?: string) => (className && /(^|\s)(w-|flex-)/.test(className) ? inputCls.replace("w-full ", "") : inputCls);

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(baseCls(props.className), props.className)} />;
}
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(props, ref) {
  return <textarea ref={ref} {...props} className={clsx(baseCls(props.className), "resize-y leading-relaxed", props.className)} />;
});
export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[] }) {
  return (
    <select {...props} className={clsx(baseCls(props.className), "pr-7", props.className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ErrorNote({ error, className }: { error?: Error | string | null; className?: string }) {
  if (!error) return null;
  return <div className={clsx("rounded-lg border border-bad-600/20 bg-bad-50 px-3 py-2 text-[12.5px] text-bad-600", className)}>{typeof error === "string" ? error : error.message}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}
