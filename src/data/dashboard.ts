import {
  Activity,
  BarChart3,
  CreditCard,
  FileText,
  Home,
  Layers3,
  LifeBuoy,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

export const navItems = [
  { label: "Overview", icon: Home, active: true },
  { label: "Customers", icon: Users },
  { label: "Billing", icon: CreditCard },
  { label: "Reports", icon: BarChart3 },
  { label: "Projects", icon: Layers3 },
  { label: "Security", icon: ShieldCheck },
];

export const secondaryNav = [
  { label: "Documentation", icon: FileText },
  { label: "Support", icon: LifeBuoy },
  { label: "Settings", icon: Settings },
];

export const metrics = [
  {
    label: "Monthly Recurring Revenue",
    value: "$428.6K",
    change: "+12.8%",
    tone: "success",
    caption: "vs. previous month",
  },
  {
    label: "Active Accounts",
    value: "18,420",
    change: "+6.1%",
    tone: "success",
    caption: "842 net new accounts",
  },
  {
    label: "Churn Risk",
    value: "2.7%",
    change: "-0.4%",
    tone: "success",
    caption: "enterprise segment",
  },
  {
    label: "Open Incidents",
    value: "9",
    change: "+3",
    tone: "warning",
    caption: "requires review",
  },
];

export const orders = [
  {
    account: "Acme Holdings",
    plan: "Enterprise",
    owner: "Maya Chen",
    amount: "$24,800",
    status: "Paid",
    date: "Jul 01, 2026",
  },
  {
    account: "Northstar Labs",
    plan: "Scale",
    owner: "Ethan Brooks",
    amount: "$9,420",
    status: "Pending",
    date: "Jun 30, 2026",
  },
  {
    account: "Brightline Studio",
    plan: "Business",
    owner: "Nora Patel",
    amount: "$5,120",
    status: "Paid",
    date: "Jun 29, 2026",
  },
  {
    account: "Atlas Commerce",
    plan: "Enterprise",
    owner: "Leo Wright",
    amount: "$18,300",
    status: "Failed",
    date: "Jun 29, 2026",
  },
  {
    account: "Fieldstone AI",
    plan: "Scale",
    owner: "Avery Stone",
    amount: "$11,760",
    status: "Paid",
    date: "Jun 28, 2026",
  },
  {
    account: "Orbital Supply",
    plan: "Business",
    owner: "Lina Park",
    amount: "$4,680",
    status: "Pending",
    date: "Jun 27, 2026",
  },
];

export const activities = [
  { label: "API latency improved", value: "184ms", icon: Activity, tone: "success" },
  { label: "Seats added this week", value: "312", icon: Users, tone: "primary" },
  { label: "Invoices requiring action", value: "7", icon: CreditCard, tone: "warning" },
];
