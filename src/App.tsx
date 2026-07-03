import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Eye, EyeOff, GripVertical, Loader2, Minus, Plus, X } from "lucide-react";
import { ApiError, api } from "./api";
import type {
  Brand,
  InventoryLog,
  PermissionCode,
  Product,
  ProductInventoryRow,
  ProductSalesBreakdown,
  ProductSalesTop,
  SalesAmountRow,
  SalesTrend,
  Session,
  Sku,
  SkuInventoryRow,
  User,
} from "./types";
import { Button } from "./components/ui/button";
import { EChart } from "./components/charts/EChart";
import { Input } from "./components/ui/input";
import { Select } from "./components/ui/select";

const sessionKey = "fish-cms-session";
const pageKey = "fish-cms-current-page";
const serverExpiryForceKey = "fish-cms-server-expiry-forced";
const serverExpiryDate = "2027-06-01";
const serverExpiryAt = new Date(`${serverExpiryDate}T00:00:00+08:00`).getTime();
const serverExpiryWarningDays = 10;
const dayMs = 24 * 60 * 60 * 1000;
const tableBase = "w-full border-collapse text-left text-sm";
const thBase = "border border-slate-200 bg-slate-50 px-4 py-2 text-left font-medium text-slate-600";
const tdBase = "border border-slate-200 px-4 py-2 align-middle";
const actionTh = `${thBase} w-[120px]`;
const dragTh = `${thBase} w-[44px] text-center`;
const actionTd = `${tdBase} w-[120px]`;
const dragTd = `${tdBase} w-[44px] text-center`;
const userActionTh = `${thBase} w-[112px]`;
const userActionTd = `${tdBase} w-[112px]`;
const pageSize = 50;

const permissionLabels: Record<PermissionCode, string> = {
  SUPER: "超级权限",
  INVENTORY: "库存权限",
  FINANCE: "财务权限",
};

type PageKey =
  | "users"
  | "brand-list"
  | "product-list"
  | "sku-list"
  | "inventory-summary"
  | "inventory-detail"
  | "inventory-logs"
  | "sales-stats"
  | "inventory-amount"
  | "sales-amount";

type DialogType = null | "user" | "brand" | "product" | "sku" | "inbound" | "outbound";
type LogFilters = { startAt: string; endAt: string };
type SkuFilters = { brandId: number | ""; productId: number | "" };
type FilterBrandOption = { id: number; name: string };
type FilterProductOption = { id: number; brandId: number; name: string };

type NavGroup = {
  label: string;
  required?: PermissionCode[];
  children?: Array<{ key: PageKey; label: string; required?: PermissionCode[] }>;
  key?: PageKey;
};

const navGroups: NavGroup[] = [
  { key: "users", label: "用户管理", required: ["SUPER"] },
  {
    label: "商品管理",
    required: ["SUPER"],
    children: [
      { key: "brand-list", label: "品牌管理" },
      { key: "product-list", label: "商品管理" },
      { key: "sku-list", label: "SKU 管理" },
    ],
  },
  {
    label: "库存管理",
    required: ["SUPER", "INVENTORY"],
    children: [
      { key: "inventory-summary", label: "库存总计" },
      { key: "inventory-detail", label: "库存明细" },
      { key: "inventory-logs", label: "库存操作" },
    ],
  },
  {
    label: "数据统计",
    required: ["SUPER", "FINANCE"],
    children: [
      { key: "sales-stats", label: "销量统计", required: ["SUPER"] },
      { key: "inventory-amount", label: "库存金额", required: ["SUPER", "FINANCE"] },
      { key: "sales-amount", label: "销售金额", required: ["SUPER", "FINANCE"] },
    ],
  },
];

function hasAccess(permissions: PermissionCode[], required?: PermissionCode[]) {
  if (!required) return permissions.length > 0;
  return required.some((permission) => permissions.includes(permission));
}

function getDefaultPage(permissions: PermissionCode[]): PageKey {
  if (permissions.includes("SUPER")) return "sales-stats";
  if (permissions.includes("INVENTORY")) return "inventory-logs";
  if (permissions.includes("FINANCE")) return "inventory-amount";
  return "inventory-summary";
}

function loadSession(): Session | null {
  const raw = localStorage.getItem(sessionKey);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Session;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(sessionKey);
      return null;
    }
    return session;
  } catch {
    localStorage.removeItem(sessionKey);
    return null;
  }
}

function getServerExpiryDaysLeft() {
  return Math.max(0, Math.floor((serverExpiryAt - Date.now()) / dayMs));
}

function rowSpanFor<T>(rows: T[], index: number, getKey: (row: T) => string | number) {
  const key = getKey(rows[index]);
  if (index > 0 && getKey(rows[index - 1]) === key) return 0;
  let count = 1;
  for (let next = index + 1; next < rows.length; next += 1) {
    if (getKey(rows[next]) !== key) break;
    count += 1;
  }
  return count;
}

function uniqueBy<T>(rows: T[], getKey: (row: T) => string | number) {
  const seen = new Set<string | number>();
  return rows.filter((row) => {
    const key = getKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function usePagination<T>(rows: T[], size = pageSize) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / size));

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * size;
  const pageRows = useMemo(() => rows.slice(start, start + size), [rows, start, size]);

  return {
    page: safePage,
    totalPages,
    pageRows,
    start: rows.length ? start + 1 : 0,
    end: Math.min(start + size, rows.length),
    total: rows.length,
    setPage,
  };
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [page, setPage] = useState<PageKey>(() => {
    const savedPage = localStorage.getItem(pageKey);
    return savedPage === "stats" ? "sales-stats" : ((savedPage as PageKey | null) || "inventory-summary");
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [productInventory, setProductInventory] = useState<ProductInventoryRow[]>([]);
  const [skuInventory, setSkuInventory] = useState<SkuInventoryRow[]>([]);
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [logPage, setLogPage] = useState(1);
  const [logTotal, setLogTotal] = useState(0);
  const [logFilters, setLogFilters] = useState<LogFilters>({ startAt: "", endAt: "" });
  const [logFilterDraft, setLogFilterDraft] = useState<LogFilters>({ startAt: "", endAt: "" });
  const [skuFilters, setSkuFilters] = useState<SkuFilters>({ brandId: "", productId: "" });
  const [inventoryDetailFilters, setInventoryDetailFilters] = useState<SkuFilters>({ brandId: "", productId: "" });
  const [dialog, setDialog] = useState<DialogType>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [modalProducts, setModalProducts] = useState<Product[]>([]);
  const [modalSkus, setModalSkus] = useState<Sku[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [sqlPreview, setSqlPreview] = useState("");
  const [currentStock, setCurrentStock] = useState<{ salableQty: number; unsalableQty: number } | null>(null);
  const serverExpiryDaysLeft = getServerExpiryDaysLeft();
  const isServerExpiryUrgent = serverExpiryDaysLeft < serverExpiryWarningDays;

  const visibleGroups = useMemo(() => {
    if (!session) return [];
    return navGroups
      .filter((group) => hasAccess(session.permissions, group.required))
      .map((group) => ({
        ...group,
        children: group.children?.filter((item) => hasAccess(session.permissions, item.required)),
      }));
  }, [session]);

  const activePage = visibleGroups.some((group) =>
    group.key === page || group.children?.some((child) => child.key === page),
  )
    ? page
    : session
      ? getDefaultPage(session.permissions)
      : "inventory-summary";

  useEffect(() => {
    if (!session) return;
    if (activePage !== page) {
      setPage(activePage);
      localStorage.setItem(pageKey, activePage);
    }
  }, [activePage, page, session]);

  function changePage(nextPage: PageKey) {
    setPage(nextPage);
    localStorage.setItem(pageKey, nextPage);
  }

  function forceLogout() {
    localStorage.removeItem(sessionKey);
    setSession(null);
    setMessage("");
  }

  useEffect(() => {
    if (!session) return;
    if (isServerExpiryUrgent && localStorage.getItem(serverExpiryForceKey) !== serverExpiryDate) {
      localStorage.setItem(serverExpiryForceKey, serverExpiryDate);
      localStorage.removeItem(sessionKey);
      setSession(null);
      setMessage("距离服务器到期不足 10 天，请重新登录确认");
      return;
    }
    api.me(session.token).catch((nextError) => {
      if (nextError instanceof ApiError && nextError.status === 401) forceLogout();
    });
  }, [session, isServerExpiryUrgent]);

  useEffect(() => {
    if (session) void refreshData(session);
  }, []);

  async function refreshData(activeSession = session, nextLogPage = 1, nextLogFilters = logFilters) {
    if (!activeSession) return;
    setIsLoading(true);
    setError("");
    try {
      const token = activeSession.token;
      const canManage = activeSession.permissions.includes("SUPER");
      const [nextBrands, nextProducts, nextSkus, nextProductInventory, nextSkuInventory, nextLogs, nextUsers] =
        await Promise.all([
          api.brands(token),
          api.products(token, undefined, canManage),
          api.skus(token, undefined, canManage),
          api.productInventory(token),
          api.skuInventory(token),
          api.logs(token, nextLogPage, pageSize, nextLogFilters),
          canManage ? api.users(token) : Promise.resolve([]),
        ]);
      setBrands(nextBrands);
      setProducts(canManage ? nextProducts : []);
      setSkus(canManage ? nextSkus : []);
      setProductInventory(nextProductInventory);
      setSkuInventory(nextSkuInventory);
      setLogs(nextLogs.rows);
      setLogPage(nextLogPage);
      setLogTotal(nextLogs.total);
      setLogFilters(nextLogFilters);
      setUsers(nextUsers);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "数据加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadLogPage(nextPage: number, activeSession = session, nextLogFilters = logFilters) {
    if (!activeSession) return;
    setError("");
    try {
      const nextLogs = await api.logs(activeSession.token, nextPage, pageSize, nextLogFilters);
      setLogs(nextLogs.rows);
      setLogPage(nextPage);
      setLogTotal(nextLogs.total);
      setLogFilters(nextLogFilters);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "鏁版嵁鍔犺浇澶辫触");
    }
  }

  async function loadSkuList(filters = skuFilters, activeSession = session) {
    if (!activeSession) return;
    setError("");
    try {
      const rows = await api.skus(
        activeSession.token,
        filters.productId ? Number(filters.productId) : undefined,
        activeSession.permissions.includes("SUPER"),
        filters.brandId ? Number(filters.brandId) : undefined,
      );
      setSkus(rows);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "SKU 加载失败");
    }
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoginLoading) return;
    setMessage("");
    setIsLoginLoading(true);
    try {
      const nextSession = await api.login(username, password);
      if (isServerExpiryUrgent) localStorage.setItem(serverExpiryForceKey, serverExpiryDate);
      localStorage.setItem(sessionKey, JSON.stringify(nextSession));
      setSession(nextSession);
      const nextPage = getDefaultPage(nextSession.permissions);
      setPage(nextPage);
      localStorage.setItem(pageKey, nextPage);
      await refreshData(nextSession);
      if (isServerExpiryUrgent) {
        window.alert(`距离服务器到期还有 ${serverExpiryDaysLeft} 天，请及时处理服务器续费。`);
      }
    } catch (nextError) {
      setMessage(nextError instanceof Error ? nextError.message : "登录失败");
    } finally {
      setIsLoginLoading(false);
    }
  }
  function handleLogout() {
    localStorage.removeItem(sessionKey);
    setSession(null);
    setMessage("已退出登录");
  }

  function patchForm(key: string, value: unknown) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleFormChange(key: string, value: unknown) {
    patchForm(key, value);
    if (key === "label" && value !== "unsalable") patchForm("simultaneousInbound", false);
    if (key !== "skuId") return;
    if (dialog === "outbound" && session && Number(value)) {
      void api.skuInventoryItem(session.token, Number(value)).then((row) => {
        setCurrentStock({ salableQty: Number(row.salableQty), unsalableQty: Number(row.unsalableQty) });
      });
    } else {
      setCurrentStock(null);
    }
  }

  async function loadModalProducts(brandId: number, productId?: number, autoPick = true) {
    if (!session || !brandId) return [];
    const rows = await api.products(session.token, brandId);
    setModalProducts(rows);
    const nextProductId = autoPick ? productId ?? rows[0]?.id ?? "" : productId ?? "";
    patchForm("productId", nextProductId);
    if (nextProductId) await loadModalSkus(Number(nextProductId), undefined, autoPick);
    else {
      setModalSkus([]);
      patchForm("skuId", "");
    }
    return rows;
  }

  async function loadModalSkus(productId: number, skuId?: number, autoPick = true) {
    if (!session || !productId) return [];
    const rows = await api.skus(session.token, productId);
    setModalSkus(rows);
    patchForm("skuId", autoPick ? skuId ?? rows[0]?.id ?? "" : skuId ?? "");
    return rows;
  }

  async function openUser(user?: User) {
    setEditingId(user?.id ?? null);
    setForm(
      user
        ? { username: user.username, name: user.name, password: "", confirmPassword: "", permissions: user.permissions }
        : { username: "", name: "", password: "", confirmPassword: "", permissions: ["INVENTORY"] },
    );
    setDialog("user");
  }

  function openBrand(brand?: Brand) {
    setEditingId(brand?.id ?? null);
    setForm(brand ? { name: brand.name, remark: brand.remark, defaultPlatform: brand.defaultPlatform || "" } : { name: "", remark: "", defaultPlatform: "" });
    setDialog("brand");
  }

  async function openProduct(product?: Product) {
    const firstVisibleBrand = brands.find((brand) => !brand.isHidden);
    setEditingId(product?.id ?? null);
    setForm(
      product
        ? { brandId: product.brandId, name: product.name, remark: product.remark }
        : { brandId: firstVisibleBrand?.id ?? "", name: "", remark: "" },
    );
    setDialog("product");
  }

  async function openSku(sku?: Sku) {
    const brandId = sku?.brandId ?? brands.find((brand) => !brand.isHidden)?.id ?? "";
    setEditingId(sku?.id ?? null);
    setForm(
      sku
        ? { brandId, productId: sku.productId, name: sku.name, purchasePrice: sku.purchasePrice, remark: sku.remark }
        : { brandId, productId: "", name: "", purchasePrice: "", remark: "" },
    );
    setDialog("sku");
    if (brandId) await loadModalProducts(Number(brandId), sku?.productId);
  }

  async function openStockDialog(type: "inbound" | "outbound") {
    const firstVisibleBrand = brands.find((brand) => !brand.isHidden);
    setEditingId(null);
    setCurrentStock(null);
    setForm({
      brandId: firstVisibleBrand?.id ?? "",
      productId: "",
      skuId: "",
      quantity: 1,
      label: "salable",
      inboundType: "return",
      simultaneousInbound: false,
      platform: firstVisibleBrand?.defaultPlatform || "",
      remark: "",
    });
    setDialog(type);
    if (firstVisibleBrand?.id) await loadModalProducts(firstVisibleBrand.id, undefined, false);
  }

  async function submitDialog(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !dialog) return;
    setError("");
    setNotice("");
    try {
      const token = session.token;
      if (dialog === "user") {
        if (!editingId && form.password !== form.confirmPassword) throw new Error("两次密码不一致");
        const payload = {
          username: String(form.username || "").trim(),
          name: String(form.name || "").trim(),
          password: String(form.password || ""),
          status: 1,
          permissions: form.permissions || [],
        };
        if (editingId) await api.updateUser(token, editingId, payload);
        else await api.createUser(token, payload);
      }
      if (dialog === "brand") {
        const payload = { name: String(form.name || "").trim(), remark: String(form.remark || "").trim(), defaultPlatform: form.defaultPlatform || "" };
        if (editingId) await api.updateBrand(token, editingId, payload);
        else await api.createBrand(token, payload);
      }
      if (dialog === "product") {
        const payload = {
          brandId: Number(form.brandId),
          name: String(form.name || "").trim(),
          remark: String(form.remark || "").trim(),
        };
        if (editingId) await api.updateProduct(token, editingId, payload);
        else await api.createProduct(token, payload);
      }
      if (dialog === "sku") {
        const payload = {
          productId: Number(form.productId),
          name: String(form.name || "").trim(),
          purchasePrice: Number(form.purchasePrice),
          remark: String(form.remark || "").trim(),
        };
        if (editingId) await api.updateSku(token, editingId, payload);
        else await api.createSku(token, payload);
      }
      if (dialog === "inbound" || dialog === "outbound") {
        if (!Number(form.productId)) throw new Error("请选择商品名");
        if (!Number(form.skuId)) throw new Error("请选择规格名");
        const payload = {
          skuId: Number(form.skuId),
          quantity: Number(form.quantity),
          label: form.label,
          inboundType: form.inboundType,
          simultaneousInbound: Boolean(form.simultaneousInbound),
          platform: form.platform || "",
          remark: String(form.remark || "").trim(),
        };
        if (dialog === "inbound") await api.inbound(token, payload);
        else await api.outbound(token, payload);
      }
      setDialog(null);
      setNotice("操作成功");
      await refreshData(session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "操作失败");
    }
  }

  async function deleteUser(user: User) {
    if (!session) return;
    if (!window.confirm("确认删除该用户？")) return;
    await api.deleteUser(session.token, user.id);
    setNotice("操作成功");
    await refreshData(session);
  }

  async function reorder(kind: "brand" | "product" | "sku", rows: Array<{ id: number }>, targetId: number) {
    if (!session || dragId === null || dragId === targetId) return;
    const fromIndex = rows.findIndex((row) => row.id === dragId);
    const toIndex = rows.findIndex((row) => row.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...rows];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const ids = next.map((row) => row.id);
    if (kind === "brand") await api.sortBrands(session.token, ids);
    if (kind === "product") await api.sortProducts(session.token, ids);
    if (kind === "sku") await api.sortSkus(session.token, ids);
    setDragId(null);
    await refreshData(session);
  }

  async function toggleHidden(kind: "brand" | "product" | "sku", row: { id: number; isHidden: 0 | 1 }) {
    if (!session) return;
    const nextHidden = !row.isHidden;
    if (kind === "brand") await api.setBrandHidden(session.token, row.id, nextHidden);
    if (kind === "product") await api.setProductHidden(session.token, row.id, nextHidden);
    if (kind === "sku") await api.setSkuHidden(session.token, row.id, nextHidden);
    setNotice("操作成功");
    await refreshData(session);
  }

  async function exportExcel() {
    if (!session) return;
    setError("");
    try {
      const blob = await api.exportExcel(session.token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `鱼竿库存数据-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "导出失败");
    }
  }

  async function importExcel(file: File) {
    if (!session) return;
    setError("");
    try {
      const result = await api.importExcel(session.token, file);
      setSqlPreview(result.sql);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "导入失败");
    }
  }

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-950">威海博浪峰渔具IMS</h1>
          <div className="mt-6 space-y-3">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="英文用户名" disabled={isLoginLoading} />
            <Input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" type="password" disabled={isLoginLoading} />
            {message && <p className="text-sm text-red-600">{message}</p>}
            <Button className="w-full" type="submit" disabled={isLoginLoading}>
              {isLoginLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isLoginLoading ? "登录中" : "登录"}
            </Button>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white">
        <div className="flex h-16 items-center justify-between px-6">
          <div>
            <h1 className="text-lg font-semibold">威海博浪峰渔具IMS</h1>
            <p className="text-xs text-slate-500">
              {session.user.name} · {session.permissions.map((item) => permissionLabels[item]).join("、")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={["text-sm font-medium", isServerExpiryUrgent ? "text-red-600" : "text-slate-500"].join(" ")}>
              距离服务器到期还有 {serverExpiryDaysLeft} 天
            </span>
            {session.permissions.includes("SUPER") && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void exportExcel()}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-blue-700"
                >
                  导出
                </button>
              </div>
            )}
            <Button variant="secondary" onClick={handleLogout}>
              退出登录
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-64px)]">
        <aside className="w-60 shrink-0 border-r bg-white p-4">
          <nav className="space-y-4">
            {visibleGroups.map((group) => (
              <div key={group.label} className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
                {group.key ? (
                  <NavButton active={activePage === group.key} onClick={() => changePage(group.key!)}>
                    {group.label}
                  </NavButton>
                ) : (
                  <>
                    <p className="px-3 py-2 text-xs font-semibold text-slate-400">{group.label}</p>
                    <div className="space-y-1">
                      {group.children?.map((item) => (
                        <NavButton key={item.key} active={activePage === item.key} onClick={() => changePage(item.key)}>
                          {item.label}
                        </NavButton>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 flex-1 space-y-4 p-6">
          {isLoading && <p className="rounded-lg border bg-white p-3 text-sm text-slate-500">数据加载中...</p>}
          {notice && <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
          {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {activePage === "users" && <UsersPage users={users} onAdd={() => void openUser()} onEdit={(user) => void openUser(user)} onDelete={deleteUser} />}
          {activePage === "brand-list" && (
            <BrandTable brands={brands} onAdd={() => openBrand()} onEdit={openBrand} onToggleHidden={(brand) => toggleHidden("brand", brand)} onDragStart={setDragId} onDrop={(id) => reorder("brand", brands, id)} />
          )}
          {activePage === "product-list" && (
            <ProductTable products={products} onAdd={() => void openProduct()} onEdit={(product) => void openProduct(product)} onToggleHidden={(product) => toggleHidden("product", product)} onDragStart={setDragId} onDrop={(id) => reorder("product", products, id)} />
          )}
          {activePage === "sku-list" && (
            <SkuTable
              skus={skus}
              brands={brands}
              products={products}
              filters={skuFilters}
              onFilterChange={setSkuFilters}
              onFilterApply={(filters) => void loadSkuList(filters)}
              onAdd={() => void openSku()}
              onEdit={(sku) => void openSku(sku)}
              onToggleHidden={(sku) => toggleHidden("sku", sku)}
              onDragStart={setDragId}
              onDrop={(id) => reorder("sku", skus, id)}
            />
          )}
          {activePage === "inventory-summary" && <ProductInventoryTable rows={productInventory} />}
          {activePage === "inventory-detail" && (
            <SkuInventoryPage
              rows={skuInventory}
              filters={inventoryDetailFilters}
              onFilterChange={setInventoryDetailFilters}
              onFilterApply={setInventoryDetailFilters}
            />
          )}
          {activePage === "inventory-logs" && (
            <LogTable
              logs={logs}
              page={logPage}
              total={logTotal}
              filters={logFilterDraft}
              canWrite={session.permissions.includes("SUPER") || session.permissions.includes("INVENTORY")}
              onPageChange={(nextPage) => void loadLogPage(nextPage)}
              onFilterChange={setLogFilterDraft}
              onSearch={() => void loadLogPage(1, session, logFilterDraft)}
              onReset={() => {
                const emptyFilters = { startAt: "", endAt: "" };
                setLogFilterDraft(emptyFilters);
                void loadLogPage(1, session, emptyFilters);
              }}
              onInbound={() => void openStockDialog("inbound")}
              onOutbound={() => void openStockDialog("outbound")}
            />
          )}
          {activePage === "sales-stats" && (
            <StatsPage token={session.token} brands={brands.filter((brand) => !brand.isHidden)} />
          )}
          {activePage === "inventory-amount" && <InventoryAmountPage rows={skuInventory} />}
          {activePage === "sales-amount" && <SalesAmountPage token={session.token} />}
        </section>
      </div>

      {dialog && (
        <EditorDialog
          dialog={dialog}
          editingId={editingId}
          form={form}
          brands={brands}
          products={products}
          modalProducts={modalProducts}
          modalSkus={modalSkus}
          currentStock={currentStock}
          onChange={handleFormChange}
          onBrandChange={async (brandId) => {
            const shouldAutoPick = dialog === "sku";
            patchForm("brandId", brandId);
            patchForm("productId", "");
            patchForm("skuId", "");
            setCurrentStock(null);
            if (dialog === "inbound" || dialog === "outbound") {
              const selectedBrand = brands.find((brand) => brand.id === brandId);
              patchForm("platform", selectedBrand?.defaultPlatform || "");
            }
            await loadModalProducts(brandId, undefined, shouldAutoPick);
          }}
          onProductChange={async (productId) => {
            const shouldAutoPick = dialog === "sku";
            patchForm("productId", productId);
            patchForm("skuId", "");
            setCurrentStock(null);
            await loadModalSkus(productId, undefined, shouldAutoPick);
          }}
          onClose={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      )}
      {sqlPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-4xl rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">导入 SQL 预览</h3>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(sqlPreview);
                    setNotice("SQL已复制");
                  }}
                >
                  复制全部 SQL
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSqlPreview("")}>关闭</Button>
              </div>
            </div>
            <pre className="max-h-[520px] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-4 text-sm leading-6 text-slate-100">
              <code>{sqlPreview}</code>
            </pre>
          </div>
        </div>
      )}
    </main>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex h-10 w-full items-center rounded-lg px-3 text-left text-sm font-medium transition",
        active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function ActionLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline">
      {children}
    </button>
  );
}

function DragHandle({ title = "拖拽排序" }: { title?: string }) {
  return (
    <span className="inline-flex cursor-grab items-center justify-center text-slate-400" title={title}>
      <GripVertical className="h-4 w-4" />
    </span>
  );
}

function DateRangePicker({
  filters,
  onChange,
  onClear,
}: {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasValue = Boolean(filters.startAt || filters.endAt);
  const label = hasValue
    ? `${filters.startAt ? filters.startAt.replace("T", " ") : "不限"} 至 ${filters.endAt ? filters.endAt.replace("T", " ") : "不限"}`
    : "选择时间范围";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-[330px] items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-left text-sm text-slate-700 shadow-sm hover:bg-slate-50"
      >
        <span className={["truncate", hasValue ? "text-slate-800" : "text-slate-400"].join(" ")}>{label}</span>
        {hasValue && (
          <span
            role="button"
            tabIndex={0}
            className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={(event) => {
              event.stopPropagation();
              onClear();
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onClear();
                setOpen(false);
              }
            }}
            aria-label="清空时间范围"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[360px] rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm text-slate-600">
              <span className="w-16 shrink-0 text-right">开始时间</span>
              <Input
                type="datetime-local"
                value={filters.startAt}
                onChange={(event) => onChange({ ...filters, startAt: event.target.value })}
                className="h-9"
              />
            </label>
            <label className="flex items-center gap-3 text-sm text-slate-600">
              <span className="w-16 shrink-0 text-right">结束时间</span>
              <Input
                type="datetime-local"
                value={filters.endAt}
                onChange={(event) => onChange({ ...filters, endAt: event.target.value })}
                className="h-9"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function DateRangePicker2({
  filters,
  onChange,
  onClear,
}: {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasValue = Boolean(filters.startAt || filters.endAt);
  const label = hasValue ? `${filters.startAt || "不限"} 至 ${filters.endAt || "不限"}` : "选择时间范围";

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-10 w-[260px] items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-left text-sm text-slate-700 shadow-sm hover:bg-slate-50"
      >
        <span className={["truncate", hasValue ? "text-slate-800" : "text-slate-400"].join(" ")}>{label}</span>
        {hasValue && (
          <span
            role="button"
            tabIndex={0}
            className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={(event) => {
              event.stopPropagation();
              onClear();
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onClear();
                setOpen(false);
              }
            }}
            aria-label="清空时间范围"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[320px] rounded-lg border border-slate-200 bg-white p-4 shadow-lg">
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm text-slate-600">
              <span className="w-16 shrink-0 text-right">开始日期</span>
              <Input
                type="date"
                value={filters.startAt}
                onChange={(event) => onChange({ ...filters, startAt: event.target.value })}
                className="h-10"
              />
            </label>
            <label className="flex items-center gap-3 text-sm text-slate-600">
              <span className="w-16 shrink-0 text-right">结束日期</span>
              <Input
                type="date"
                value={filters.endAt}
                onChange={(event) => onChange({ ...filters, endAt: event.target.value })}
                className="h-10"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function PaginationBar({
  page,
  totalPages,
  start,
  end,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  start: number;
  end: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= pageSize) return null;

  return (
    <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm text-slate-500">
      <span>
        共 {total} 条，当前 {start}-{end} 条
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          上一页
        </button>
        <span className="min-w-16 text-center text-slate-600">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-md border border-slate-200 px-3 py-1.5 text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  );
}

function UsersPage({
  users,
  onAdd,
  onEdit,
  onDelete,
}: {
  users: User[];
  onAdd: () => void;
  onEdit: (user: User) => void;
  onDelete: (user: User) => void;
}) {
  const pagination = usePagination(users);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">用户管理</h2>
        <Button onClick={onAdd}>添加用户</Button>
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[720px]`}>
          <thead>
            <tr>
              <th className={thBase}>真实姓名</th>
              <th className={thBase}>英文用户名</th>
              <th className={thBase}>权限</th>
              <th className={userActionTh}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((user) => (
              <tr key={user.id}>
                <td className={tdBase}>{user.name}</td>
                <td className={tdBase}>{user.username}</td>
                <td className={tdBase}>{user.permissions.map((permission) => permissionLabels[permission]).join("、")}</td>
                <td className={userActionTd}>
                  <div className="flex whitespace-nowrap gap-3">
                    <ActionLink onClick={() => onEdit(user)}>修改</ActionLink>
                    <ActionLink onClick={() => onDelete(user)}>删除</ActionLink>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
      </div>
    </section>
  );
}

function BrandTable({
  brands,
  onAdd,
  onEdit,
  onToggleHidden,
  onDragStart,
  onDrop,
}: {
  brands: Brand[];
  onAdd: () => void;
  onEdit: (brand: Brand) => void;
  onToggleHidden: (brand: Brand) => void;
  onDragStart: (id: number) => void;
  onDrop: (id: number) => void;
}) {
  const pagination = usePagination(brands);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">品牌管理</h2>
        <Button onClick={onAdd}>新增品牌</Button>
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[760px]`}>
          <thead>
            <tr>
              <th className={thBase}>品牌名</th>
              <th className={`${thBase} w-[140px]`}>默认平台</th>
              <th className={`${thBase} w-[260px]`}>备注</th>
              <th className={actionTh}>操作</th>
              <th className={dragTh}></th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((brand) => (
              <tr
                key={brand.id}
                draggable
                onDragStart={() => onDragStart(brand.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => onDrop(brand.id)}
                className={["cursor-move", brand.isHidden ? "text-slate-400" : ""].join(" ")}
              >
                <td className={tdBase}>{brand.name}</td>
                <td className={`${tdBase} w-[140px]`}>{platformLabel(brand.defaultPlatform) || "-"}</td>
                <td className={`${tdBase} max-w-[260px] truncate`}>{brand.remark || "-"}</td>
                <td className={actionTd}>
                  <div className="flex whitespace-nowrap gap-3">
                    <ActionLink onClick={() => onEdit(brand)}>修改</ActionLink>
                    <ActionLink onClick={() => onToggleHidden(brand)}>{brand.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                  </div>
                </td>
                <td className={dragTd}><DragHandle /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
      </div>
    </section>
  );
}

function ProductTable({
  products,
  onAdd,
  onEdit,
  onToggleHidden,
  onDragStart,
  onDrop,
}: {
  products: Product[];
  onAdd: () => void;
  onEdit: (product: Product) => void;
  onToggleHidden: (product: Product) => void;
  onDragStart: (id: number) => void;
  onDrop: (id: number) => void;
}) {
  const pagination = usePagination(products);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">商品管理</h2>
        <Button onClick={onAdd}>新增商品</Button>
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[860px]`}>
          <thead>
            <tr>
              <th className={thBase}>品牌名</th>
              <th className={thBase}>商品名</th>
              <th className={thBase}>备注</th>
              <th className={actionTh}>操作</th>
              <th className={dragTh}></th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((product, index) => {
              const brandSpan = rowSpanFor(pagination.pageRows, index, (row) => row.brandId);
              return (
                <tr
                  key={product.id}
                  draggable
                  onDragStart={() => onDragStart(product.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => onDrop(product.id)}
                  className={["cursor-move", product.isHidden ? "text-slate-400" : ""].join(" ")}
                >
                  {brandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={brandSpan}>{product.brandName}</td>}
                  <td className={tdBase}>{product.name}</td>
                  <td className={tdBase}>{product.remark || "-"}</td>
                  <td className={actionTd}>
                    <div className="flex whitespace-nowrap gap-3">
                      <ActionLink onClick={() => onEdit(product)}>修改</ActionLink>
                      <ActionLink onClick={() => onToggleHidden(product)}>{product.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                    </div>
                  </td>
                  <td className={dragTd}><DragHandle /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
      </div>
    </section>
  );
}

function ProductFilterControls({
  brands,
  products,
  filters,
  onFilterChange,
  onFilterApply,
}: {
  brands: FilterBrandOption[];
  products: FilterProductOption[];
  filters: SkuFilters;
  onFilterChange: (filters: SkuFilters) => void;
  onFilterApply: (filters: SkuFilters) => void;
}) {
  const productOptions = products.filter((product) => !filters.brandId || product.brandId === Number(filters.brandId));

  function applyBrandFilter(value: string) {
    const nextFilters: SkuFilters = { brandId: value ? Number(value) : "", productId: "" };
    onFilterChange(nextFilters);
    onFilterApply(nextFilters);
  }

  function applyProductFilter(value: string) {
    const nextFilters: SkuFilters = { ...filters, productId: value ? Number(value) : "" };
    onFilterChange(nextFilters);
    onFilterApply(nextFilters);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        className="h-10 w-44"
        value={String(filters.brandId || "")}
        onChange={(event) => applyBrandFilter(event.target.value)}
        onBlur={(event) => applyBrandFilter(event.currentTarget.value)}
      >
        <option value="">全部品牌</option>
        {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
      </Select>
      <Select
        className="h-10 w-44"
        value={String(filters.productId || "")}
        onChange={(event) => applyProductFilter(event.target.value)}
        onBlur={(event) => applyProductFilter(event.currentTarget.value)}
      >
        <option value="">全部商品</option>
        {productOptions.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
      </Select>
    </div>
  );
}

function SkuTable({
  skus,
  brands,
  products,
  filters,
  onFilterChange,
  onFilterApply,
  onAdd,
  onEdit,
  onToggleHidden,
  onDragStart,
  onDrop,
}: {
  skus: Sku[];
  brands: Brand[];
  products: Product[];
  filters: SkuFilters;
  onFilterChange: (filters: SkuFilters) => void;
  onFilterApply: (filters: SkuFilters) => void;
  onAdd: () => void;
  onEdit: (sku: Sku) => void;
  onToggleHidden: (sku: Sku) => void;
  onDragStart: (id: number) => void;
  onDrop: (id: number) => void;
}) {
  const pagination = usePagination(skus);
  const brandOptions = brands.filter((brand) => !brand.isHidden);
  const productOptions = products.filter((product) => !product.isHidden);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">SKU 管理</h2>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ProductFilterControls
            brands={brandOptions}
            products={productOptions}
            filters={filters}
            onFilterChange={onFilterChange}
            onFilterApply={onFilterApply}
          />
          <Button onClick={onAdd}>新增 SKU</Button>
        </div>
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[980px]`}>
          <thead>
            <tr>
              <th className={thBase}>品牌名</th>
              <th className={thBase}>商品名</th>
              <th className={thBase}>规格名</th>
              <th className={thBase}>购入价格</th>
              <th className={thBase}>备注</th>
              <th className={actionTh}>操作</th>
              <th className={dragTh}></th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((sku, index) => {
              const brandSpan = rowSpanFor(pagination.pageRows, index, (row) => row.brandId);
              const productSpan = rowSpanFor(pagination.pageRows, index, (row) => `${row.brandId}-${row.productId}`);
              return (
                <tr
                  key={sku.id}
                  draggable
                  onDragStart={() => onDragStart(sku.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => onDrop(sku.id)}
                  className={["cursor-move", sku.isHidden ? "text-slate-400" : ""].join(" ")}
                >
                  {brandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={brandSpan}>{sku.brandName}</td>}
                  {productSpan > 0 && <td className={`${tdBase} text-center`} rowSpan={productSpan}>{sku.productName}</td>}
                  <td className={tdBase}>{sku.name}</td>
                  <td className={tdBase}>¥{Number(sku.purchasePrice).toFixed(2)}</td>
                  <td className={tdBase}>{sku.remark || "-"}</td>
                  <td className={actionTd}>
                    <div className="flex whitespace-nowrap gap-3">
                      <ActionLink onClick={() => onEdit(sku)}>修改</ActionLink>
                      <ActionLink onClick={() => onToggleHidden(sku)}>{sku.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                    </div>
                  </td>
                  <td className={dragTd}><DragHandle /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
      </div>
    </section>
  );
}

function ProductInventoryTable({ rows }: { rows: ProductInventoryRow[] }) {
  const pagination = usePagination(rows);
  const total = rows.reduce(
    (sum, row) => ({
      totalQty: sum.totalQty + Number(row.totalQty),
      salableQty: sum.salableQty + Number(row.salableQty),
      unsalableQty: sum.unsalableQty + Number(row.unsalableQty),
    }),
    { totalQty: 0, salableQty: 0, unsalableQty: 0 },
  );

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="border-b p-5"><h2 className="text-lg font-semibold text-slate-950">库存总计</h2></div>
      <div className="space-y-3 p-5">
        <div className="max-h-[620px] overflow-auto">
          <table className={`${tableBase} min-w-[920px]`}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={thBase}>品牌名</th>
                <th className={thBase}>商品名</th>
                <th className={thBase}>库存总量</th>
                <th className={thBase}>可售库存数</th>
                <th className={thBase}>不可售库存数</th>
                <th className={thBase}>占有率</th>
              </tr>
            </thead>
            <tbody>
              {pagination.pageRows.map((row, index) => {
                const brandSpan = rowSpanFor(pagination.pageRows, index, (item) => item.brandId);
                const displayBrandSpan = brandSpan > 0 ? brandSpan + 1 : 0;
                const rate = total.totalQty ? Math.floor((Number(row.totalQty) / total.totalQty) * 100) : 0;
                const isLastBrandRow = !pagination.pageRows[index + 1] || pagination.pageRows[index + 1].brandId !== row.brandId;
                const brandRows = rows.filter((item) => item.brandId === row.brandId);
                const brandTotal = brandRows.reduce(
                  (sum, item) => ({
                    totalQty: sum.totalQty + Number(item.totalQty),
                    salableQty: sum.salableQty + Number(item.salableQty),
                    unsalableQty: sum.unsalableQty + Number(item.unsalableQty),
                  }),
                  { totalQty: 0, salableQty: 0, unsalableQty: 0 },
                );
                return (
                  <Fragment key={row.productId}>
                    <tr>
                      {displayBrandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={displayBrandSpan}>{row.brandName}</td>}
                      <td className={tdBase}>{row.productName}</td>
                      <td className={tdBase}>{row.totalQty}</td>
                      <td className={tdBase}>{row.salableQty}</td>
                      <td className={tdBase}>{row.unsalableQty}</td>
                      <td className={tdBase}>{rate}%</td>
                    </tr>
                    {isLastBrandRow && (
                      <tr className="bg-yellow-50 font-semibold">
                        <td className={tdBase}>总计</td>
                        <td className={tdBase}>{brandTotal.totalQty}</td>
                        <td className={tdBase}>{brandTotal.salableQty}</td>
                        <td className={tdBase}>{brandTotal.unsalableQty}</td>
                        <td className={tdBase}>{total.totalQty ? Math.floor((brandTotal.totalQty / total.totalQty) * 100) : 0}%</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
        <table className={`${tableBase} min-w-[920px]`}>
          <thead>
            <tr>
              <th className={thBase}></th>
              <th className={thBase}>库存总量</th>
              <th className={thBase}>可售库存数</th>
              <th className={thBase}>不可售库存数</th>
              <th className={thBase}>占有率</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-white font-semibold">
              <td className={tdBase}>总计</td>
              <td className={tdBase}>{total.totalQty}</td>
              <td className={tdBase}>{total.salableQty}</td>
              <td className={tdBase}>{total.unsalableQty}</td>
              <td className={tdBase}>100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SkuInventoryPage({
  rows,
  filters,
  onFilterChange,
  onFilterApply,
}: {
  rows: SkuInventoryRow[];
  filters: SkuFilters;
  onFilterChange: (filters: SkuFilters) => void;
  onFilterApply: (filters: SkuFilters) => void;
}) {
  const brandOptions = useMemo(
    () => Array.from(new Map(rows.map((row) => [row.brandId, { id: row.brandId, name: row.brandName }])).values()),
    [rows],
  );
  const productOptions = useMemo(
    () => Array.from(new Map(rows.map((row) => [row.productId, { id: row.productId, brandId: row.brandId, name: row.productName }])).values()),
    [rows],
  );
  const filteredRows = useMemo(
    () => rows.filter((row) =>
      (!filters.brandId || row.brandId === Number(filters.brandId)) &&
      (!filters.productId || row.productId === Number(filters.productId)),
    ),
    [rows, filters],
  );
  const pagination = usePagination(filteredRows);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">库存明细</h2>
        <ProductFilterControls
          brands={brandOptions}
          products={productOptions}
          filters={filters}
          onFilterChange={onFilterChange}
          onFilterApply={onFilterApply}
        />
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[900px]`}>
          <thead>
            <tr>
              <th className={thBase}>品牌名</th>
              <th className={thBase}>商品名</th>
              <th className={thBase}>规格名</th>
              <th className={thBase}>库存总量</th>
              <th className={thBase}>可售库存数</th>
              <th className={thBase}>不可售库存数</th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((row, index) => {
              const brandSpan = rowSpanFor(pagination.pageRows, index, (item) => item.brandId);
              const productSpan = rowSpanFor(pagination.pageRows, index, (item) => `${item.brandId}-${item.productId}`);
              const salable = Number(row.salableQty);
              return (
                <tr key={row.skuId}>
                  {brandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={brandSpan}>{row.brandName}</td>}
                  {productSpan > 0 && <td className={`${tdBase} text-center`} rowSpan={productSpan}>{row.productName}</td>}
                  <td className={tdBase}>{row.skuName}</td>
                  <td className={tdBase}>{salable + Number(row.unsalableQty)}</td>
                  <td className={[tdBase, salable === 0 ? "bg-red-100 font-semibold text-red-700" : salable === 1 ? "bg-amber-100 font-semibold text-amber-700" : ""].join(" ")}>{salable}</td>
                  <td className={tdBase}>{row.unsalableQty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <PaginationBar {...pagination} onPageChange={pagination.setPage} />
      </div>
    </section>
  );
}

function LogTable({
  logs,
  page,
  total,
  filters,
  canWrite,
  onPageChange,
  onFilterChange,
  onSearch,
  onReset,
  onInbound,
  onOutbound,
}: {
  logs: InventoryLog[];
  page: number;
  total: number;
  filters: LogFilters;
  canWrite: boolean;
  onPageChange: (page: number) => void;
  onFilterChange: (filters: LogFilters) => void;
  onSearch: () => void;
  onReset: () => void;
  onInbound: () => void;
  onOutbound: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, (page - 1) * pageSize + logs.length);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">库存操作</h2>
        <div className="flex flex-wrap items-center justify-end gap-x-8 gap-y-2">
          <div className="flex items-center gap-2">
            <DateRangePicker2 filters={filters} onChange={onFilterChange} onClear={onReset} />
            <Button size="sm" variant="secondary" onClick={onSearch}>查询</Button>
          </div>
          {canWrite && (
            <div className="flex items-center gap-2">
              <Button onClick={onOutbound}>出库</Button>
              <Button onClick={onInbound}>入库</Button>
            </div>
          )}
        </div>
      </div>
      <div className="overflow-auto p-5">
        <table className={`${tableBase} min-w-[980px]`}>
          <thead>
            <tr>
              <th className={thBase}>时间</th>
              <th className={thBase}>类型</th>
              <th className={thBase}>品牌名</th>
              <th className={thBase}>商品名</th>
              <th className={thBase}>规格名</th>
              <th className={thBase}>入库类型</th>
              <th className={thBase}>标签</th>
              <th className={thBase}>平台</th>
              <th className={thBase}>数量</th>
              <th className={thBase}>操作人</th>
              <th className={thBase}>备注</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td className={tdBase}>{String(log.createdAt).replace("T", " ").slice(0, 19)}</td>
                <td className={tdBase}><OperationTypeBadge value={log.operationType} /></td>
                <td className={tdBase}>{log.brandName}</td>
                <td className={tdBase}>{log.productName}</td>
                <td className={tdBase}>{log.skuName}</td>
                <td className={tdBase}>{log.operationType === 1 ? <InboundTypeText value={log.inboundType} /> : ""}</td>
                <td className={tdBase}><StockLabelText value={log.stockLabel} /></td>
                <td className={tdBase}>{platformLabel(log.platform)}</td>
                <td className={tdBase}>{log.quantity}</td>
                <td className={tdBase}>{log.operatorName}</td>
                <td className={tdBase}>{log.remark || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <PaginationBar page={page} totalPages={totalPages} start={start} end={end} total={total} onPageChange={onPageChange} />
      </div>
    </section>
  );
}

function StatsPage({ token, brands }: { token: string; brands: Brand[] }) {
  const [brandId, setBrandId] = useState<number>(brands[0]?.id ?? 0);
  const [brandDays, setBrandDays] = useState(7);
  const [topDays, setTopDays] = useState(7);
  const [trendPeriod, setTrendPeriod] = useState("day");
  const [trendBrandIds, setTrendBrandIds] = useState<number[]>(() => brands.map((brand) => brand.id));
  const [brandSales, setBrandSales] = useState<ProductSalesBreakdown[]>([]);
  const [topSales, setTopSales] = useState<ProductSalesTop[]>([]);
  const [trend, setTrend] = useState<SalesTrend>({ labels: [], values: [] });
  const [statsError, setStatsError] = useState("");

  useEffect(() => {
    if (!brands.length) return;
    setBrandId((current) => (current && brands.some((brand) => brand.id === current) ? current : brands[0].id));
    setTrendBrandIds((current) => (current.length ? current.filter((id) => brands.some((brand) => brand.id === id)) : brands.map((brand) => brand.id)));
  }, [brands]);

  useEffect(() => {
    if (!brandId) return;
    api.brandProductSales(token, brandId, brandDays).then(setBrandSales).catch((error) => setStatsError(error instanceof Error ? error.message : "销量统计加载失败"));
  }, [token, brandId, brandDays]);

  useEffect(() => {
    api.productSalesTop(token, topDays).then(setTopSales).catch((error) => setStatsError(error instanceof Error ? error.message : "销量统计加载失败"));
  }, [token, topDays]);

  useEffect(() => {
    const ids = trendBrandIds.length ? trendBrandIds : brands.map((brand) => brand.id);
    api.salesTrend(token, trendPeriod, ids).then(setTrend).catch((error) => setStatsError(error instanceof Error ? error.message : "销量趋势加载失败"));
  }, [token, trendPeriod, trendBrandIds, brands]);

  function toggleTrendBrand(id: number) {
    setTrendBrandIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  const brandSalesOption = useMemo<EChartsOption>(() => {
    const displayBrandSales = brandSales
      .map((product) => {
        const topSkus = product.skus
          .filter((sku) => Number(sku.quantity) > 0)
          .sort((a, b) => Number(b.quantity) - Number(a.quantity))
          .slice(0, 5);
        const topSkuQty = topSkus.reduce((sum, sku) => sum + Number(sku.quantity), 0);
        const otherQty = Math.max(0, Number(product.totalQty) - topSkuQty);
        return {
          ...product,
          skus: otherQty > 0 ? [...topSkus, { skuId: 0, skuName: "其他", quantity: otherQty }] : topSkus,
        };
      })
      .filter((product) => Number(product.totalQty) > 0)
      .sort((a, b) => Number(b.totalQty) - Number(a.totalQty))
      .slice(0, 5);
    const skuNames = [...new Set(displayBrandSales.flatMap((product) => product.skus.map((sku) => sku.skuName)))];
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const items = (Array.isArray(params) ? params : [params]) as Array<{ axisValueLabel?: string; marker?: string; seriesName?: string; value?: unknown }>;
          const visibleItems = items.filter((item) => Number(item.value) > 0);
          const title = visibleItems[0]?.axisValueLabel || items[0]?.axisValueLabel || "";
          if (!visibleItems.length) return title;
          return [
            title,
            ...visibleItems.map((item) => `${item.marker || ""}${item.seriesName}　${item.value}`),
          ].join("<br/>");
        },
      },
      legend: { top: 0 },
      grid: { left: 48, right: 24, top: 48, bottom: 48 },
      xAxis: { type: "category", data: displayBrandSales.map((product) => product.productName), axisLabel: { interval: 0 } },
      yAxis: { type: "value" },
      series: skuNames.map((skuName) => ({
        name: skuName,
        type: "bar",
        stack: "sku",
        emphasis: { focus: "series" },
        data: displayBrandSales.map((product) => product.skus.find((sku) => sku.skuName === skuName)?.quantity ?? 0),
      })),
    };
  }, [brandSales]);

  const topSalesOption = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 48, right: 24, top: 24, bottom: 72 },
    xAxis: { type: "category", data: topSales.map((item) => `${item.brandName}-${item.productName}`), axisLabel: { interval: 0, rotate: 25 } },
    yAxis: { type: "value" },
    series: [{ name: "销量", type: "bar", data: topSales.map((item) => Number(item.quantity)), itemStyle: { color: "#2563eb" } }],
  }), [topSales]);

  const trendOption = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: "axis" },
    grid: { left: 48, right: 24, top: 24, bottom: 48 },
    xAxis: { type: "category", data: trend.labels },
    yAxis: { type: "value" },
    series: [{ name: "总销量", type: "line", smooth: true, data: trend.values, areaStyle: { opacity: 0.08 }, itemStyle: { color: "#16a34a" } }],
  }), [trend]);

  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="border-b p-5">
          <h2 className="text-lg font-semibold text-slate-950">数据统计</h2>
        </div>
        {statsError && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{statsError}</p>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-950">品牌商品销量 Top5</h3>
            <div className="flex shrink-0 gap-2">
              <Select className="w-28" value={String(brandId || "")} onChange={(event) => setBrandId(Number(event.target.value))}>
                {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </Select>
              <Select className="w-24" value={String(brandDays)} onChange={(event) => setBrandDays(Number(event.target.value))}>
                <option value="7">7天</option>
                <option value="15">15天</option>
                <option value="30">30天</option>
              </Select>
            </div>
          </div>
          <EChart option={brandSalesOption} className="h-[360px]" />
        </section>

        <section className="rounded-lg border bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-950">全部商品销量 Top10</h3>
            <div className="flex shrink-0 gap-2">
              <Select className="w-24" value={String(topDays)} onChange={(event) => setTopDays(Number(event.target.value))}>
                <option value="7">7天</option>
                <option value="15">15天</option>
                <option value="30">30天</option>
              </Select>
            </div>
          </div>
          <EChart option={topSalesOption} className="h-[360px]" />
        </section>
      </div>

      <section className="rounded-lg border bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-950">总销量趋势</h3>
          <div className="flex shrink-0 gap-2">
            <Select className="w-36" value={trendPeriod} onChange={(event) => setTrendPeriod(event.target.value)}>
              <option value="day">日（15日内）</option>
              <option value="week">周（8周）</option>
              <option value="month">月（6个月内）</option>
            </Select>
            <details className="relative">
              <summary className="flex h-10 w-40 cursor-pointer list-none items-center justify-between rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700">
                已选 {trendBrandIds.length || brands.length} 个品牌
              </summary>
              <div className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
                <div className="mb-2 flex justify-between text-sm">
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => setTrendBrandIds(brands.map((brand) => brand.id))}>全选</button>
                  <button type="button" className="text-blue-600 hover:underline" onClick={() => setTrendBrandIds([])}>清空</button>
                </div>
                <div className="max-h-56 space-y-2 overflow-auto">
                  {brands.map((brand) => (
                    <label key={brand.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={trendBrandIds.includes(brand.id)} onChange={() => toggleTrendBrand(brand.id)} />
                      {brand.name}
                    </label>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </div>
        <EChart option={trendOption} className="h-[380px]" />
      </section>
    </section>
  );
}

function formatMoney(value: number) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

type AmountRow = {
  brandId: number;
  brandName: string;
  productId: number;
  productName: string;
  skuId: number;
  skuName: string;
  quantity: number;
  amount: number;
};

function AmountTable({ rows, quantityTitle, amountTitle }: { rows: AmountRow[]; quantityTitle: string; amountTitle: string }) {
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(() => new Set());
  const productGroups = useMemo(() => {
    const groups = new Map<string, AmountRow[]>();
    for (const row of rows) {
      const key = `${row.brandId}-${row.productId}`;
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    return [...groups.entries()].map(([key, groupRows]) => {
      const first = groupRows[0];
      return {
        key,
        brandId: first.brandId,
        brandName: first.brandName,
        productId: first.productId,
        productName: first.productName,
        rows: groupRows,
        totalAmount: groupRows.reduce((sum, row) => sum + row.amount, 0),
      };
    });
  }, [rows]);
  const pagination = usePagination(productGroups);
  const pageGroups = pagination.pageRows;
  const productTotals = useMemo(() => {
    const totals = new Map<number, number>();
    for (const row of rows) totals.set(row.productId, (totals.get(row.productId) || 0) + row.amount);
    return totals;
  }, [rows]);
  const brandTotals = useMemo(() => {
    const totals = new Map<number, number>();
    for (const row of rows) totals.set(row.brandId, (totals.get(row.brandId) || 0) + row.amount);
    return totals;
  }, [rows]);
  const visibleBrandSpan = (startIndex: number) => {
    const brandId = pageGroups[startIndex]?.brandId;
    let span = 0;
    for (let index = startIndex; index < pageGroups.length && pageGroups[index].brandId === brandId; index += 1) {
      span += expandedProducts.has(pageGroups[index].key) ? 2 : 1;
    }
    return span;
  };
  const toggleProduct = (key: string) => {
    setExpandedProducts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="overflow-auto p-5">
      <table className={`${tableBase} min-w-[760px]`}>
        <thead>
          <tr>
            <th className={thBase}>品牌名</th>
            <th className={thBase}>商品名</th>
            <th className={thBase}>商品总金额</th>
            <th className={thBase}>品牌总金额</th>
          </tr>
        </thead>
        <tbody>
          {pageGroups.map((group, index) => {
            const brandSpan = index === 0 || pageGroups[index - 1].brandId !== group.brandId ? visibleBrandSpan(index) : 0;
            const expanded = expandedProducts.has(group.key);
            return (
              <Fragment key={group.key}>
                <tr>
                  {brandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={brandSpan}>{group.brandName}</td>}
                  <td className={tdBase}>
                    <button
                      type="button"
                      className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-slate-600 hover:border-blue-400 hover:text-blue-600"
                      onClick={() => toggleProduct(group.key)}
                      aria-label={expanded ? "折叠明细" : "展开明细"}
                    >
                      {expanded ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    </button>
                    {group.productName}
                  </td>
                  <td className={tdBase}>{formatMoney(productTotals.get(group.productId) || 0)}</td>
                  {brandSpan > 0 && <td className={tdBase} rowSpan={brandSpan}>{formatMoney(brandTotals.get(group.brandId) || 0)}</td>}
                </tr>
                {expanded && (
                  <tr>
                    <td className={`${tdBase} bg-slate-50`} colSpan={2}>
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr>
                            <th className="border border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-600">规格名</th>
                            <th className="border border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-600">{quantityTitle}</th>
                            <th className="border border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-600">{amountTitle}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map((row) => (
                            <tr key={row.skuId}>
                              <td className="border border-slate-200 bg-white px-3 py-2">{row.skuName}</td>
                              <td className="border border-slate-200 bg-white px-3 py-2">{row.quantity}</td>
                              <td className="border border-slate-200 bg-white px-3 py-2">{formatMoney(row.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <PaginationBar {...pagination} onPageChange={pagination.setPage} />
    </div>
  );
}

function InventoryAmountPage({ rows }: { rows: SkuInventoryRow[] }) {
  const amountRows = useMemo<AmountRow[]>(
    () =>
      rows.map((row) => {
        const quantity = Number(row.salableQty) + Number(row.unsalableQty);
        return {
          brandId: row.brandId,
          brandName: row.brandName,
          productId: row.productId,
          productName: row.productName,
          skuId: row.skuId,
          skuName: row.skuName,
          quantity,
          amount: quantity * Number(row.purchasePrice),
        };
      }),
    [rows],
  );
  const totalAmount = useMemo(
    () => amountRows.reduce((sum, row) => sum + row.amount, 0),
    [amountRows],
  );

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">库存金额</h2>
        <div className="text-sm font-medium text-slate-900">总金额：{formatMoney(totalAmount)}</div>
      </div>
      <AmountTable rows={amountRows} quantityTitle="库存总量" amountTitle="库存金额" />
    </section>
  );
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function SalesAmountPage({ token }: { token: string }) {
  const [startDate, setStartDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 6);
    return formatDateInput(date);
  });
  const [endDate, setEndDate] = useState(() => formatDateInput(new Date()));
  const [rows, setRows] = useState<AmountRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.salesAmount(token, startDate, endDate)
      .then((nextRows) => {
        setRows(nextRows.map((row) => ({
          brandId: row.brandId,
          brandName: row.brandName,
          productId: row.productId,
          productName: row.productName,
          skuId: row.skuId,
          skuName: row.skuName,
          quantity: Number(row.salesQty),
          amount: Number(row.costAmount),
        })));
        setError("");
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "销售金额加载失败"));
  }, [token, startDate, endDate]);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
        <h2 className="text-lg font-semibold text-slate-950">销售金额</h2>
        <div className="flex items-center gap-2">
          <Input className="w-40" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <span className="text-sm text-slate-500">至</span>
          <Input className="w-40" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </div>
      </div>
      {error && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <AmountTable rows={rows} quantityTitle="销售数量" amountTitle="成本金额" />
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm font-medium text-slate-700">
      <span className="w-28 shrink-0 text-right text-slate-600">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        className="pr-10"
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        onClick={() => setVisible((current) => !current)}
      >
        <Icon className="h-4 w-4" />
      </button>
    </div>
  );
}

function DefaultPlatformPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const options = [
    { value: "pinduoduo", label: "拼多多" },
    { value: "douyin", label: "抖音" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-4">
      {options.map((option) => (
        <label key={option.value} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="radio"
            name="defaultPlatform"
            checked={value === option.value}
            onChange={() => onChange(value === option.value ? "" : option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
function EditorDialog({
  dialog,
  editingId,
  form,
  currentStock,
  brands,
  products,
  modalProducts,
  modalSkus,
  onChange,
  onBrandChange,
  onProductChange,
  onClose,
  onSubmit,
}: {
  dialog: DialogType;
  editingId: number | null;
  form: Record<string, any>;
  currentStock: { salableQty: number; unsalableQty: number } | null;
  brands: Brand[];
  products: Product[];
  modalProducts: Product[];
  modalSkus: Sku[];
  onChange: (key: string, value: unknown) => void;
  onBrandChange: (brandId: number) => Promise<void>;
  onProductChange: (productId: number) => Promise<void>;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const activeBrands = brands.filter((brand) => !brand.isHidden);
  const productOptions = (modalProducts.length ? modalProducts : products.filter((product) => product.brandId === Number(form.brandId))).filter((product) => !product.isHidden);
  const skuOptions = (modalSkus.length ? modalSkus : []).filter((sku) => !sku.isHidden);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-xl rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{dialog === "inbound" ? "入库" : dialog === "outbound" ? "出库" : editingId ? "修改" : "新增"}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </div>
        <div className="grid gap-3">
          {dialog === "user" && (
            <>
              <Field label="英文用户名"><Input value={form.username || ""} onChange={(event) => onChange("username", event.target.value)} required pattern="[A-Za-z][A-Za-z0-9_]{2,31}" /></Field>
              <Field label="真实姓名"><Input value={form.name || ""} onChange={(event) => onChange("name", event.target.value)} required /></Field>
              {editingId ? (
                <Field label="密码（留空则不修改）"><PasswordInput value={form.password || ""} onChange={(value) => onChange("password", value)} /></Field>
              ) : (
                <>
                  <Field label="密码"><Input type="password" value={form.password || ""} onChange={(event) => onChange("password", event.target.value)} required /></Field>
                  <Field label="密码确认"><Input type="password" value={form.confirmPassword || ""} onChange={(event) => onChange("confirmPassword", event.target.value)} required /></Field>
                </>
              )}
              <PermissionPicker value={form.permissions || []} onChange={(value) => onChange("permissions", value)} />
            </>
          )}
          {dialog === "brand" && (
            <>
              <Field label="品牌名"><Input value={form.name || ""} onChange={(event) => onChange("name", event.target.value)} required maxLength={15} /></Field>
              <Field label="默认平台"><DefaultPlatformPicker value={form.defaultPlatform || ""} onChange={(value) => onChange("defaultPlatform", value)} /></Field>
              <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
            </>
          )}
          {dialog === "product" && (
            <>
              <Field label="品牌名"><Select value={String(form.brandId || "")} onChange={(event) => onChange("brandId", Number(event.target.value))} required>{activeBrands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</Select></Field>
              <Field label="商品名"><Input value={form.name || ""} onChange={(event) => onChange("name", event.target.value)} required maxLength={15} /></Field>
              <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
            </>
          )}
          {dialog === "sku" && (
            <>
              <Field label="品牌名"><Select value={String(form.brandId || "")} onChange={(event) => void onBrandChange(Number(event.target.value))} required>{activeBrands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</Select></Field>
              <Field label="商品名"><Select value={String(form.productId || "")} onChange={(event) => void onProductChange(Number(event.target.value))} required>{productOptions.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
              <Field label="规格名"><Input value={form.name || ""} onChange={(event) => onChange("name", event.target.value)} required maxLength={15} /></Field>
              <Field label="购入价格"><Input type="number" min="0" step="0.01" value={form.purchasePrice || ""} onChange={(event) => onChange("purchasePrice", event.target.value)} required /></Field>
              <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
            </>
          )}
          {(dialog === "inbound" || dialog === "outbound") && (
            <>
              <Field label="品牌名"><Select value={String(form.brandId || "")} onChange={(event) => void onBrandChange(Number(event.target.value))} required>{activeBrands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</Select></Field>
              <Field label="商品名">
                <Select
                  value={String(form.productId || "")}
                  className={!form.productId ? "text-slate-400 [&>option]:text-slate-800" : "[&>option]:text-slate-800"}
                  onChange={(event) => {
                    if (!event.target.value) {
                      onChange("productId", "");
                      onChange("skuId", "");
                      return;
                    }
                    void onProductChange(Number(event.target.value));
                  }}
                  required
                >
                  <option value="">请选择商品</option>
                  {productOptions.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                </Select>
              </Field>
              <Field label="规格名">
                <Select
                  value={String(form.skuId || "")}
                  className={!form.skuId ? "text-slate-400 [&>option]:text-slate-800" : "[&>option]:text-slate-800"}
                  onChange={(event) => onChange("skuId", event.target.value ? Number(event.target.value) : "")}
                  required
                >
                  <option value="">请选择规格</option>
                  {skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.name}</option>)}
                </Select>
              </Field>
              <Field label="数量">
                <div className="space-y-1">
                  <Input type="number" min="1" step="1" value={form.quantity || 1} onChange={(event) => onChange("quantity", event.target.value)} required />
                  {dialog === "outbound" && currentStock !== null && (
                    <p className="text-xs font-medium text-red-600">
                      当前库存数：{form.label === "unsalable" ? currentStock.unsalableQty : currentStock.salableQty}
                    </p>
                  )}
                </div>
              </Field>
              {dialog === "inbound" && <Field label="类型"><Select value={form.inboundType || "return"} onChange={(event) => onChange("inboundType", event.target.value)}><option value="return">退货</option><option value="new">新货</option></Select></Field>}
              <Field label="平台">
                <Select value={form.platform || ""} onChange={(event) => onChange("platform", event.target.value)}>
                  <option value=""></option>
                  <option value="douyin">抖音</option>
                  <option value="pinduoduo">拼多多</option>
                </Select>
              </Field>
              <Field label="标签">
                <StockLabelPicker value={form.label || "salable"} onChange={(value) => onChange("label", value)}>
                  {dialog === "outbound" && form.label === "unsalable" && (
                    <label className="ml-2 flex items-center gap-2 text-sm font-normal text-slate-700">
                      <input type="checkbox" checked={Boolean(form.simultaneousInbound)} onChange={(event) => onChange("simultaneousInbound", event.target.checked)} />
                      同时入库到可售库存
                    </label>
                  )}
                </StockLabelPicker>
              </Field>
              <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
            </>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit">确定</Button>
        </div>
      </form>
    </div>
  );
}

function StockLabelPicker({ value, onChange, children }: { value: string; onChange: (value: string) => void; children?: React.ReactNode }) {
  const options = [
    {
      value: "salable",
      label: "可售",
      activeClass: "border-green-600 bg-green-50 text-green-700",
      inactiveClass: "border-slate-200 bg-white text-slate-600 hover:border-green-300",
    },
    {
      value: "unsalable",
      label: "不可售",
      activeClass: "border-red-600 bg-red-50 text-red-700",
      inactiveClass: "border-slate-200 bg-white text-slate-600 hover:border-red-300",
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={[
              "h-7 min-w-14 rounded border px-3 text-xs font-semibold transition",
              active ? option.activeClass : option.inactiveClass,
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
      {children}
    </div>
  );
}

function OperationTypeBadge({ value }: { value: number }) {
  const isInbound = Number(value) === 1;
  return (
    <span
      className={[
        "inline-flex h-7 items-center rounded-md border px-3 text-sm font-semibold",
        isInbound ? "border-yellow-500 bg-yellow-50 text-yellow-700" : "border-green-600 bg-green-50 text-green-700",
      ].join(" ")}
    >
      {isInbound ? "入库" : "出库"}
    </span>
  );
}

function InboundTypeText({ value }: { value: number | null | undefined }) {
  const isReturn = Number(value) === 2;
  return <span className={isReturn ? "font-medium text-red-600" : undefined}>{isReturn ? "退货" : "新货"}</span>;
}

function StockLabelText({ value }: { value: number }) {
  const isUnsalable = Number(value) === 2;
  return <span className={isUnsalable ? "font-medium text-red-600" : undefined}>{isUnsalable ? "不可售" : "可售"}</span>;
}

function platformLabel(value?: string) {
  if (value === "douyin") return "抖音";
  if (value === "pinduoduo") return "拼多多";
  return "";
}

function PermissionPicker({ value, onChange }: { value: PermissionCode[]; onChange: (value: PermissionCode[]) => void }) {
  function toggle(permission: PermissionCode) {
    if (value.includes(permission)) onChange(value.filter((item) => item !== permission));
    else onChange([...value, permission]);
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      {(Object.keys(permissionLabels) as PermissionCode[]).map((permission) => (
        <label key={permission} className="flex items-center gap-2 rounded-lg border p-2 text-sm">
          <input type="checkbox" checked={value.includes(permission)} onChange={() => toggle(permission)} />
          {permissionLabels[permission]}
        </label>
      ))}
    </div>
  );
}
