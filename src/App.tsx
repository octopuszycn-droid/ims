import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { Download, Eye, EyeOff, GripVertical, Loader2, Menu, Minus, PencilLine, Plus, X } from "lucide-react";
import { ApiError, api } from "./api";
import type {
  Brand,
  InventoryAbnormalLog,
  InventoryCheckDifference,
  InventoryCheckRecord,
  InventoryLog,
  InventoryLogFilters,
  PermissionCode,
  PlatformValue,
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
const outboundMemoryKey = "fish-cms-outbound-memory";
const outboundMemoryTtlMs = 60 * 60 * 1000;
const serverExpiryForceKey = "fish-cms-server-expiry-forced";
const serverExpiryDate = "2027-06-01";
const serverExpiryAt = new Date(`${serverExpiryDate}T00:00:00+08:00`).getTime();
const serverExpiryWarningDays = 10;
const dayMs = 24 * 60 * 60 * 1000;
const emptyLogFilters: InventoryLogFilters = { startAt: "", endAt: "", operationType: "", brandId: "", productId: "", inboundType: "", stockLabel: "", platform: "" };
const platformOptions: Array<{ value: Exclude<PlatformValue, "">; label: string }> = [
  { value: "douyin", label: "抖音" },
  { value: "pinduoduo", label: "拼多多" },
  { value: "kuaishou", label: "快手" },
  { value: "xianyu", label: "闲鱼" },
  { value: "wechat", label: "微信" },
  { value: "video_account", label: "视频号" },
];
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
  | "inventory-checks"
  | "sales-stats"
  | "inventory-amount"
  | "sales-amount";

type DialogType = null | "user" | "brand" | "product" | "sku" | "inbound" | "outbound" | "abnormal";
type SkuFilters = { brandId: number | ""; productId: number | "" };
type FilterBrandOption = { id: number; name: string };
type FilterProductOption = { id: number; brandId: number; name: string };
type OutboundMemory = { brandId: number | ""; platformByBrand: Record<string, PlatformValue>; updatedAt: number };

type NavGroup = {
  label: string;
  required?: PermissionCode[];
  children?: Array<{ key: PageKey; label: string; required?: PermissionCode[] }>;
  key?: PageKey;
};

function readOutboundMemory(): OutboundMemory | null {
  try {
    const raw = window.localStorage.getItem(outboundMemoryKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OutboundMemory;
    if (!parsed.updatedAt || Date.now() - parsed.updatedAt > outboundMemoryTtlMs) {
      window.localStorage.removeItem(outboundMemoryKey);
      return null;
    }
    return { brandId: parsed.brandId || "", platformByBrand: parsed.platformByBrand || {}, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function rememberOutboundSelection(brandId: number | "", platform: PlatformValue) {
  if (!brandId) return;
  const current = readOutboundMemory();
  const next: OutboundMemory = {
    brandId,
    platformByBrand: { ...(current?.platformByBrand || {}), [String(brandId)]: platform || "" },
    updatedAt: Date.now(),
  };
  window.localStorage.setItem(outboundMemoryKey, JSON.stringify(next));
}

function getOutboundBrand(brands: Brand[]) {
  const activeBrands = brands.filter((brand) => !brand.isHidden);
  const memory = readOutboundMemory();
  return activeBrands.find((brand) => brand.id === memory?.brandId) || activeBrands[0] || null;
}

function getOutboundPlatform(brand?: Brand | null) {
  if (!brand) return "";
  const memory = readOutboundMemory();
  return (memory?.platformByBrand?.[String(brand.id)] || brand.defaultPlatform || "") as PlatformValue;
}

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
      { key: "inventory-checks", label: "库存盘点" },
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

function parseLocalDateTime(value: string) {
  const normalized = String(value || "").replace("T", " ");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return 0;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
}

function formatRevokeCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(restSeconds).padStart(2, "0")}`;
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
  const [logFilters, setLogFilters] = useState<InventoryLogFilters>(emptyLogFilters);
  const [logFilterDraft, setLogFilterDraft] = useState<InventoryLogFilters>(emptyLogFilters);
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
  const [unsalableAdjust, setUnsalableAdjust] = useState<{ row: SkuInventoryRow; quantity: number; addToSalable: boolean } | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const serverExpiryDaysLeft = getServerExpiryDaysLeft();
  const isServerExpiryUrgent = serverExpiryDaysLeft < serverExpiryWarningDays;

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  async function refreshData(activeSession = session, nextLogPage = 1, nextLogFilters: InventoryLogFilters = logFilters) {
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

  async function loadLogPage(nextPage: number, activeSession = session, nextLogFilters: InventoryLogFilters = logFilters) {
    if (!activeSession) return;
    setError("");
    try {
      const nextLogs = await api.logs(activeSession.token, nextPage, pageSize, nextLogFilters);
      setLogs(nextLogs.rows);
      setLogPage(nextPage);
      setLogTotal(nextLogs.total);
      setLogFilters(nextLogFilters);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "数据加载失败");
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
    if ((dialog === "outbound" || dialog === "abnormal") && session && Number(value)) {
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
        ? { username: user.username, email: user.email || "", name: user.name, password: "", confirmPassword: "", permissions: user.permissions }
        : { username: "", email: "", name: "", password: "", confirmPassword: "", permissions: ["INVENTORY"] },
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
        : { brandId, productId: "", name: "", purchasePrice: "", remark: "", rows: [{ name: "", purchasePrice: "", remark: "" }] },
    );
    setDialog("sku");
    if (brandId) await loadModalProducts(Number(brandId), sku?.productId);
  }

  async function openStockDialog(type: "inbound" | "outbound") {
    const firstVisibleBrand = type === "outbound" ? getOutboundBrand(brands) : brands.find((brand) => !brand.isHidden);
    setEditingId(null);
    setCurrentStock(null);
    setForm({
      brandId: firstVisibleBrand?.id ?? "",
      productId: "",
      skuId: "",
      quantity: 1,
      label: "salable",
      inboundType: "new",
      simultaneousInbound: false,
      platform: type === "outbound" ? getOutboundPlatform(firstVisibleBrand) : "",
      remark: "",
      rows: [{ skuId: "", quantity: 1, platform: type === "outbound" ? getOutboundPlatform(firstVisibleBrand) : "", orderId: "", shopIncome: "", remark: "", inboundType: "new", isRepair: false, label: "salable" }],
    });
    setDialog(type);
    if (firstVisibleBrand?.id) await loadModalProducts(firstVisibleBrand.id, undefined, false);
  }

  async function openAbnormalDialog() {
    const firstVisibleBrand = brands.find((brand) => !brand.isHidden);
    setEditingId(null);
    setCurrentStock(null);
    setForm({
      brandId: firstVisibleBrand?.id ?? "",
      productId: "",
      skuId: "",
      quantity: 1,
      reason: "",
    });
    setDialog("abnormal");
    if (firstVisibleBrand?.id) await loadModalProducts(firstVisibleBrand.id, undefined, false);
  }

  async function submitDialog(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !dialog) return;
    setError("");
    setNotice("");
    let nextSkuFilters: SkuFilters | null = null;
    try {
      const token = session.token;
      if (dialog === "user") {
        if (!editingId && form.password !== form.confirmPassword) throw new Error("两次密码不一致");
        const payload = {
          username: String(form.username || "").trim(),
          email: String(form.email || "").trim(),
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
        else {
          const created = await api.createProduct(token, payload);
          nextSkuFilters = { brandId: Number(form.brandId), productId: Number(created.id) };
        }
      }
      if (dialog === "sku") {
        const payload = {
          productId: Number(form.productId),
          name: String(form.name || "").trim(),
          purchasePrice: Number(form.purchasePrice),
          remark: String(form.remark || "").trim(),
        };
        if (editingId) await api.updateSku(token, editingId, payload);
        else {
          const rows = Array.isArray(form.rows) ? form.rows : [];
          if (!rows.length || rows.some((row: Record<string, unknown>) => !String(row.name || "").trim() || row.purchasePrice === "" || row.purchasePrice === undefined)) {
            throw new Error("请完整填写每一行规格名和购入价格");
          }
          await api.createSkusBatch(token, Number(form.productId), rows.map((row: Record<string, unknown>) => ({
            name: String(row.name || "").trim(),
            purchasePrice: Number(row.purchasePrice),
            remark: String(row.remark || "").trim(),
          })));
          const product = products.find((item) => item.id === Number(form.productId)) || modalProducts.find((item) => item.id === Number(form.productId));
          nextSkuFilters = { brandId: product?.brandId ?? Number(form.brandId) ?? "", productId: Number(form.productId) };
        }
      }
      if (dialog === "inbound" || dialog === "outbound") {
        if (!Number(form.productId)) throw new Error("请选择商品名");
        const rows = Array.isArray(form.rows) ? form.rows : [];
        if (!rows.length || rows.some((row: Record<string, unknown>) => !Number(row.skuId) || !Number.isInteger(Number(row.quantity)) || Number(row.quantity) <= 0)) {
          throw new Error("请完整填写每一行规格名和正整数数量");
        }
        await api.inventoryOperationsBatch(token, dialog === "inbound" ? "in" : "out", rows.map((row: Record<string, any>) => ({
          skuId: Number(row.skuId),
          quantity: Number(row.quantity),
          label: "salable",
          inboundType: dialog === "inbound" ? row.inboundType : "new",
          isRepair: dialog === "inbound" && row.inboundType === "return" && Boolean(row.isRepair),
          simultaneousInbound: false,
          platform: row.platform || "",
          orderId: dialog === "outbound" ? String(row.orderId || "").trim() : "",
          shopIncome: dialog === "outbound" ? row.shopIncome || null : null,
          remark: String(row.remark || "").trim(),
        })));
        if (dialog === "outbound") rememberOutboundSelection(Number(form.brandId), (rows[rows.length - 1]?.platform || "") as PlatformValue);
      }
      if (dialog === "abnormal") {
        if (!Number(form.productId)) throw new Error("请选择商品名");
        if (!Number(form.skuId)) throw new Error("请选择规格名");
        const payload = {
          skuId: Number(form.skuId),
          quantity: Number(form.quantity),
          reason: String(form.reason || "").trim(),
          addToUnsalable: Number(form.quantity) < 0 && Boolean(form.addToUnsalable),
        };
        if (!payload.reason) throw new Error("请填写原因");
        await api.abnormalInventory(token, payload);
      }
      setDialog(null);
      setNotice("操作成功");
      await refreshData(session);
      if (nextSkuFilters) {
        setSkuFilters(nextSkuFilters);
        await loadSkuList(nextSkuFilters, session);
      }
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

  async function updateUserBrandSubscriptions(user: User, brandIds: number[]) {
    if (!session) return;
    const result = await api.updateUserBrandSubscriptions(session.token, user.id, brandIds);
    setUsers((current) => current.map((item) => (item.id === user.id ? { ...item, subscribedBrandIds: result.subscribedBrandIds } : item)));
    setNotice("操作成功");
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

  async function exportInventoryDetail() {
    if (!session) return;
    setError("");
    try {
      const blob = await api.exportInventoryDetail(session.token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `库存明细-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "导出失败");
    }
  }

  async function exportSkuList() {
    if (!session) return;
    setError("");
    try {
      const blob = await api.exportSkus(session.token, skuFilters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `SKU管理-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "导出失败");
    }
  }

  async function exportInventoryLogs() {
    if (!session) return;
    setError("");
    try {
      const blob = await api.exportInventoryLogs(session.token, logFilterDraft);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `库存操作-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "导出失败");
    }
  }

  async function submitUnsalableAdjust(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !unsalableAdjust) return;
    setError("");
    setNotice("");
    try {
      await api.adjustUnsalable(session.token, unsalableAdjust.row.skuId, {
        quantity: unsalableAdjust.quantity,
        addToSalable: unsalableAdjust.addToSalable,
      });
      setUnsalableAdjust(null);
      setNotice("操作成功");
      await refreshData(session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "操作失败");
    }
  }

  async function revokeInventoryLog(log: InventoryLog) {
    if (!session) return;
    if (!window.confirm("确定撤销这条库存操作吗？库存数量会同步恢复。")) return;
    setError("");
    setNotice("");
    try {
      await api.revokeInventoryLog(session.token, log.id);
      setNotice("撤销成功");
      await refreshData(session, logPage, logFilters);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "撤销失败");
    }
  }

  async function resolveImportedOrder(log: InventoryLog, skuId: number) {
    if (!session) return;
    try {
      await api.resolveImportedOrder(session.token, log.id, skuId);
      setNotice("异常商品已补全并出库");
      await refreshData(session);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "补全失败");
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
      <main className="flex min-h-screen flex-col bg-slate-50">
        <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
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
        </div>
        <IcpFooter />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col overflow-x-hidden bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white">
        <div className="flex min-h-16 items-center justify-between gap-3 px-3 py-2 sm:px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button className="md:hidden" variant="ghost" size="icon" onClick={() => setMobileNavOpen(true)} aria-label="打开导航">
              <Menu className="h-5 w-5" />
            </Button>
            <div className="min-w-0">
            <h1 className="truncate text-base font-semibold sm:text-lg">威海博浪峰渔具IMS</h1>
            <p className="text-xs text-slate-500">
              {session.user.name} · {session.permissions.map((item) => permissionLabels[item]).join("、")}
            </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className={["hidden text-sm font-medium sm:inline", isServerExpiryUrgent ? "text-red-600" : "text-slate-500"].join(" ")}>
              距离服务器到期还有 {serverExpiryDaysLeft} 天
            </span>
            {false && (
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

      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="关闭导航" className="absolute inset-0 bg-slate-950/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[82vw] overflow-y-auto border-r bg-white p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-950">导航</h2>
                <p className="text-xs text-slate-500">{session.user.name}</p>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen(false)} aria-label="关闭导航">
                <X className="h-5 w-5" />
              </Button>
            </div>
            <nav className="space-y-4">
              {visibleGroups.map((group) => (
                <div key={group.label} className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
                  {group.key ? (
                    <NavButton active={activePage === group.key} onClick={() => {
                      changePage(group.key!);
                      setMobileNavOpen(false);
                    }}>
                      {group.label}
                    </NavButton>
                  ) : (
                    <>
                      <p className="px-3 py-2 text-xs font-semibold text-slate-400">{group.label}</p>
                      <div className="space-y-1">
                        {group.children?.map((item) => (
                          <NavButton key={item.key} active={activePage === item.key} onClick={() => {
                            changePage(item.key);
                            setMobileNavOpen(false);
                          }}>
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
        </div>
      )}

      <div className="flex min-h-[calc(100vh-64px)] flex-1">
        <aside className="hidden w-60 shrink-0 border-r bg-white p-4 md:block">
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

        <section className="min-w-0 flex-1 space-y-4 p-3 sm:p-4 lg:p-6">
          {isLoading && <p className="rounded-lg border bg-white p-3 text-sm text-slate-500">数据加载中...</p>}
          {notice && <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
          {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          {activePage === "users" && <UsersPage users={users} brands={brands} onAdd={() => void openUser()} onEdit={(user) => void openUser(user)} onDelete={deleteUser} onSubscriptionChange={(user, brandIds) => void updateUserBrandSubscriptions(user, brandIds)} />}
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
              onExport={() => void exportSkuList()}
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
              canWrite={session.permissions.includes("SUPER") || session.permissions.includes("INVENTORY")}
              onAdjust={(row) => setUnsalableAdjust({ row, quantity: 1, addToSalable: false })}
              onExport={() => void exportInventoryDetail()}
            />
          )}
          {activePage === "inventory-logs" && (
            <LogTable
              logs={logs}
              page={logPage}
              total={logTotal}
              filters={logFilterDraft}
              catalogRows={skuInventory}
              canWrite={session.permissions.includes("SUPER") || session.permissions.includes("INVENTORY")}
              onPageChange={(nextPage) => void loadLogPage(nextPage)}
              onFilterChange={setLogFilterDraft}
              onFilterApply={(nextFilters) => void loadLogPage(1, session, nextFilters)}
              onExport={() => void exportInventoryLogs()}
              onRevoke={(log) => void revokeInventoryLog(log)}
              onResolve={(log, skuId) => void resolveImportedOrder(log, skuId)}
              onReset={() => {
                setLogFilterDraft(emptyLogFilters);
                void loadLogPage(1, session, emptyLogFilters);
              }}
              onInbound={() => void openStockDialog("inbound")}
              onOutbound={() => void openStockDialog("outbound")}
              onAbnormal={() => void openAbnormalDialog()}
            />
          )}
          {activePage === "inventory-checks" && (
            <InventoryCheckPage
              token={session.token}
              canUpload={session.permissions.includes("SUPER") || session.permissions.includes("INVENTORY")}
              onInventoryChanged={() => void refreshData(session)}
            />
          )}
          {activePage === "sales-stats" && (
            <StatsPage token={session.token} brands={brands.filter((brand) => !brand.isHidden)} />
          )}
          {activePage === "inventory-amount" && <InventoryAmountPage rows={skuInventory} token={session.token} />}
          {activePage === "sales-amount" && <SalesAmountPage token={session.token} />}
        </section>
      </div>
      <IcpFooter />

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
              const nextPlatform = dialog === "outbound" ? getOutboundPlatform(selectedBrand) : "";
              patchForm("platform", nextPlatform);
              patchForm("rows", (form.rows || []).map((row: Record<string, unknown>) => ({ ...row, platform: nextPlatform })));
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
      {unsalableAdjust && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 sm:items-center sm:p-4">
          <form onSubmit={submitUnsalableAdjust} className="max-h-[calc(100vh-1.5rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:max-h-[calc(100vh-2rem)] sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">修改不可售库存</h3>
              <Button variant="ghost" size="sm" onClick={() => setUnsalableAdjust(null)}>关闭</Button>
            </div>
            <div className="grid gap-3">
              <Field label="不可售数">
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-slate-700">-</span>
                  <Input
                    type="number"
                    min="1"
                    max={Number(unsalableAdjust.row.unsalableQty)}
                    step="1"
                    value={unsalableAdjust.quantity}
                    onChange={(event) => setUnsalableAdjust((current) => current ? { ...current, quantity: Number(event.target.value) } : current)}
                    required
                  />
                </div>
              </Field>
              <Field label="选择">
                <label className="flex items-center gap-2 text-sm font-normal text-slate-700">
                  <input
                    type="checkbox"
                    checked={unsalableAdjust.addToSalable}
                    onChange={(event) => setUnsalableAdjust((current) => current ? { ...current, addToSalable: event.target.checked } : current)}
                  />
                  同时加回可售库中
                </label>
              </Field>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button className="flex-1 sm:flex-none" variant="secondary" onClick={() => setUnsalableAdjust(null)}>取消</Button>
              <Button className="flex-1 sm:flex-none" type="submit">确定</Button>
            </div>
          </form>
        </div>
      )}
      {sqlPreview && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 sm:items-center sm:p-4">
          <div className="max-h-[calc(100vh-1.5rem)] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:max-h-[calc(100vh-2rem)] sm:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

function IcpFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white px-4 py-3 text-center text-xs text-slate-500">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer" className="hover:text-blue-600 hover:underline">
        鲁ICP备2025147752号-2
      </a>
    </footer>
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
  filters: Pick<InventoryLogFilters, "startAt" | "endAt">;
  onChange: (filters: Pick<InventoryLogFilters, "startAt" | "endAt">) => void;
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
  filters: Pick<InventoryLogFilters, "startAt" | "endAt">;
  onChange: (filters: Pick<InventoryLogFilters, "startAt" | "endAt">) => void;
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
        className="flex h-10 w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-left text-sm text-slate-700 shadow-sm hover:bg-slate-50 sm:w-[260px]"
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
        <div className="absolute left-0 z-20 mt-2 w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-4 shadow-lg sm:left-auto sm:right-0 sm:w-[320px]">
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

function BrandSubscriptionSelector({
  user,
  brands,
  layout = "mobile",
  onChange,
}: {
  user: User;
  brands: Brand[];
  layout?: "mobile" | "desktop";
  onChange: (brandIds: number[]) => void;
}) {
  if (!user.permissions.includes("SUPER") || !user.email) return <span className="text-slate-400">-</span>;
  const selected = new Set(user.subscribedBrandIds || []);
  const visibleBrands = brands.filter((brand) => brand.name !== "流水补录");
  if (visibleBrands.length === 0) return <span className="text-slate-400">暂无品牌</span>;
  return (
    <div className={["flex flex-wrap gap-2 overflow-auto pr-1 text-xs", layout === "desktop" ? "max-h-[4.4rem]" : "max-h-28"].join(" ")}>
      {visibleBrands.map((brand) => (
        <label key={brand.id} className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-slate-700">
          <input
            type="checkbox"
            checked={selected.has(brand.id)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(brand.id);
              else next.delete(brand.id);
              onChange([...next]);
            }}
          />
          {brand.name}
        </label>
      ))}
    </div>
  );
}

function UsersPage({
  users,
  brands,
  onAdd,
  onEdit,
  onDelete,
  onSubscriptionChange,
}: {
  users: User[];
  brands: Brand[];
  onAdd: () => void;
  onEdit: (user: User) => void;
  onDelete: (user: User) => void;
  onSubscriptionChange: (user: User, brandIds: number[]) => void;
}) {
  const pagination = usePagination(users);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">用户管理</h2>
        <Button className="shrink-0" onClick={onAdd}>添加用户</Button>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-3 md:hidden">
          {pagination.pageRows.map((user) => (
            <article key={user.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-950">{user.name}</h3>
                  <p className="text-xs text-slate-500">{user.username}</p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <ActionLink onClick={() => onEdit(user)}>修改</ActionLink>
                  <ActionLink onClick={() => onDelete(user)}>删除</ActionLink>
                </div>
              </div>
              <InfoLine label="权限" value={user.permissions.map((permission) => permissionLabels[permission]).join("、")} />
              <InfoLine label="邮箱" value={user.email || "-"} />
              <div className="mt-2">
                <p className="mb-1 text-xs text-slate-500">订阅品牌</p>
                <BrandSubscriptionSelector user={user} brands={brands} onChange={(brandIds) => onSubscriptionChange(user, brandIds)} />
              </div>
            </article>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
        <table className={`${tableBase} min-w-[1040px]`}>
          <thead>
            <tr>
              <th className={thBase}>真实姓名</th>
              <th className={thBase}>英文用户名</th>
              <th className={thBase}>邮箱</th>
              <th className={thBase}>权限</th>
              <th className={thBase}>订阅品牌</th>
              <th className={userActionTh}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.pageRows.map((user) => (
              <tr key={user.id}>
                <td className={tdBase}>{user.name}</td>
                <td className={tdBase}>{user.username}</td>
                <td className={tdBase}>{user.email || "-"}</td>
                <td className={tdBase}>{user.permissions.map((permission) => permissionLabels[permission]).join("、")}</td>
                <td className={tdBase}>
                  <BrandSubscriptionSelector user={user} brands={brands} layout="desktop" onChange={(brandIds) => onSubscriptionChange(user, brandIds)} />
                </td>
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
        </div>
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
      <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">品牌管理</h2>
        <Button onClick={onAdd}>新增品牌</Button>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-2 md:hidden">
          {pagination.pageRows.map((brand) => (
            <article
              key={brand.id}
              draggable
              onDragStart={() => onDragStart(brand.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDrop(brand.id)}
              className={["rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm", brand.isHidden ? "text-slate-400" : ""].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <DragHandle />
                    <h3 className="truncate font-semibold text-slate-950">{brand.name}</h3>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    默认平台：{platformLabel(brand.defaultPlatform) || "-"}{brand.remark ? ` · ${brand.remark}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <ActionLink onClick={() => onEdit(brand)}>修改</ActionLink>
                  <ActionLink onClick={() => onToggleHidden(brand)}>{brand.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                </div>
              </div>
              {Boolean(brand.isHidden) && <p className="mt-1 text-xs text-slate-400">已隐藏</p>}
            </article>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
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
        </div>
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
      <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">商品管理</h2>
        <Button onClick={onAdd}>新增商品</Button>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-2 md:hidden">
          {pagination.pageRows.map((product) => (
            <article
              key={product.id}
              draggable
              onDragStart={() => onDragStart(product.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDrop(product.id)}
              className={["rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm", product.isHidden ? "text-slate-400" : ""].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <DragHandle />
                    <h3 className="truncate font-semibold text-slate-950">{product.name}</h3>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {product.brandName}{product.remark ? ` · ${product.remark}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <ActionLink onClick={() => onEdit(product)}>修改</ActionLink>
                  <ActionLink onClick={() => onToggleHidden(product)}>{product.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
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
        </div>
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
    <div className="grid w-full grid-cols-1 gap-3 sm:flex sm:w-auto sm:flex-nowrap sm:items-center">
      <Select
        className="h-10 w-full sm:w-44"
        value={String(filters.brandId || "")}
        onChange={(event) => applyBrandFilter(event.target.value)}
        onBlur={(event) => applyBrandFilter(event.currentTarget.value)}
      >
        <option value="">全部品牌</option>
        {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
      </Select>
      <Select
        className="h-10 w-full sm:w-44"
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
  onExport,
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
  onExport: () => void;
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
      <div className="flex flex-col gap-4 border-b p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-lg font-semibold text-slate-950">SKU 管理</h2>
        <div className="grid w-full grid-cols-1 gap-3 sm:flex sm:w-auto sm:flex-nowrap sm:items-center sm:justify-end">
          <ProductFilterControls
            brands={brandOptions}
            products={productOptions}
            filters={filters}
            onFilterChange={onFilterChange}
            onFilterApply={onFilterApply}
          />
          <div className="grid grid-cols-2 gap-3 sm:flex sm:w-auto sm:flex-nowrap">
            <Button className="w-full sm:w-auto" onClick={onAdd}>新增 SKU</Button>
            <Button className="w-full sm:w-auto" onClick={onExport}>导出</Button>
          </div>
        </div>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-2 md:hidden">
          {pagination.pageRows.map((sku) => (
            <article
              key={sku.id}
              draggable
              onDragStart={() => onDragStart(sku.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => onDrop(sku.id)}
              className={["rounded-md border border-slate-200 bg-white px-3 py-2 shadow-sm", sku.isHidden ? "text-slate-400" : ""].join(" ")}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <DragHandle />
                    <h3 className="truncate font-semibold text-slate-950">{sku.name}</h3>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {sku.brandName} · {sku.productName}{sku.remark ? ` · ${sku.remark}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-sm font-medium text-slate-900">¥{Number(sku.purchasePrice).toFixed(2)}</span>
                  <ActionLink onClick={() => onEdit(sku)}>修改</ActionLink>
                  <ActionLink onClick={() => onToggleHidden(sku)}>{sku.isHidden ? "取消隐藏" : "隐藏"}</ActionLink>
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
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
        </div>
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
  const mobileGroups = useMemo(() => {
    const groups = new Map<number, {
      brandId: number;
      brandName: string;
      totalQty: number;
      salableQty: number;
      unsalableQty: number;
      rows: ProductInventoryRow[];
    }>();
    for (const row of pagination.pageRows) {
      const current = groups.get(row.brandId) || {
        brandId: row.brandId,
        brandName: row.brandName,
        totalQty: 0,
        salableQty: 0,
        unsalableQty: 0,
        rows: [],
      };
      current.totalQty += Number(row.totalQty);
      current.salableQty += Number(row.salableQty);
      current.unsalableQty += Number(row.unsalableQty);
      current.rows.push(row);
      groups.set(row.brandId, current);
    }
    return [...groups.values()];
  }, [pagination.pageRows]);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="border-b p-4 sm:p-5"><h2 className="text-lg font-semibold text-slate-950">库存总计</h2></div>
      <div className="space-y-3 p-3 sm:p-5">
        <div className="grid gap-3 md:hidden">
          {mobileGroups.map((brand) => (
            <article key={brand.brandId} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b bg-slate-50 px-3 py-2">
                <div>
                  <h3 className="font-semibold text-slate-950">{brand.brandName}</h3>
                  <p className="text-xs text-slate-500">可售 {brand.salableQty}</p>
                </div>
                <span className="shrink-0 rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">总 {brand.totalQty}</span>
              </div>
              <div className="p-3">
                <table className="w-full table-fixed border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">商品名</th>
                      <th className="w-14 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">总</th>
                      <th className="w-14 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">可售</th>
                      <th className="w-14 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {brand.rows.map((row) => {
                      const rate = total.totalQty ? Math.floor((Number(row.totalQty) / total.totalQty) * 100) : 0;
                      return (
                        <tr key={row.productId}>
                          <td className="break-words border border-slate-200 px-2 py-1.5">{row.productName}</td>
                          <td className="border border-slate-200 px-2 py-1.5">{row.totalQty}</td>
                          <td className="border border-slate-200 px-2 py-1.5">{row.salableQty}</td>
                          <td className="border border-slate-200 px-2 py-1.5">{rate}%</td>
                        </tr>
                      );
                    })}
                    <tr className="bg-yellow-50 font-semibold">
                      <td className="border border-slate-200 px-2 py-1.5">总计</td>
                      <td className="border border-slate-200 px-2 py-1.5">{brand.totalQty}</td>
                      <td className="border border-slate-200 px-2 py-1.5">{brand.salableQty}</td>
                      <td className="border border-slate-200 px-2 py-1.5">{total.totalQty ? Math.floor((brand.totalQty / total.totalQty) * 100) : 0}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
        <div className="hidden max-h-[620px] overflow-auto md:block">
          <table className={`${tableBase} min-w-[920px]`}>
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={thBase}>品牌名</th>
                <th className={thBase}>商品名</th>
                <th className={thBase}>库存总量</th>
                <th className={thBase}>可售库存数</th>
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
                      <td className={tdBase}>{rate}%</td>
                    </tr>
                    {isLastBrandRow && (
                      <tr className="bg-yellow-50 font-semibold">
                        <td className={tdBase}>总计</td>
                        <td className={tdBase}>{brandTotal.totalQty}</td>
                        <td className={tdBase}>{brandTotal.salableQty}</td>
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
        <div className="rounded-lg border border-slate-200 bg-white p-3 md:hidden">
          <h3 className="mb-2 font-semibold text-slate-950">全部总计</h3>
          <div className="grid grid-cols-2 gap-2 text-center text-sm">
            <div className="rounded-md bg-slate-50 p-2"><p className="text-xs text-slate-500">总</p><p className="font-semibold">{total.totalQty}</p></div>
            <div className="rounded-md bg-slate-50 p-2"><p className="text-xs text-slate-500">可售</p><p className="font-semibold">{total.salableQty}</p></div>
          </div>
        </div>
        <div className="hidden overflow-auto md:block">
        <table className={`${tableBase} min-w-[920px]`}>
          <thead>
            <tr>
              <th className={thBase}></th>
              <th className={thBase}>库存总量</th>
              <th className={thBase}>可售库存数</th>
              <th className={thBase}>占有率</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-white font-semibold">
              <td className={tdBase}>总计</td>
              <td className={tdBase}>{total.totalQty}</td>
              <td className={tdBase}>{total.salableQty}</td>
              <td className={tdBase}>100%</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </section>
  );
}

function SkuInventoryPage({
  rows,
  filters,
  onFilterChange,
  onFilterApply,
  canWrite,
  onAdjust,
  onExport,
}: {
  rows: SkuInventoryRow[];
  filters: SkuFilters;
  onFilterChange: (filters: SkuFilters) => void;
  onFilterApply: (filters: SkuFilters) => void;
  canWrite: boolean;
  onAdjust: (row: SkuInventoryRow) => void;
  onExport: () => void;
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
  const mobileGroups = useMemo(() => {
    const brandMap = new Map<number, {
      brandId: number;
      brandName: string;
      totalQty: number;
      salableQty: number;
      unsalableQty: number;
      products: Map<number, {
        productId: number;
        productName: string;
        totalQty: number;
        salableQty: number;
        unsalableQty: number;
        rows: SkuInventoryRow[];
      }>;
    }>();

    for (const row of pagination.pageRows) {
      let brand = brandMap.get(row.brandId);
      if (!brand) {
        brand = {
          brandId: row.brandId,
          brandName: row.brandName,
          totalQty: 0,
          salableQty: 0,
          unsalableQty: 0,
          products: new Map(),
        };
        brandMap.set(row.brandId, brand);
      }

      let product = brand.products.get(row.productId);
      if (!product) {
        product = {
          productId: row.productId,
          productName: row.productName,
          totalQty: 0,
          salableQty: 0,
          unsalableQty: 0,
          rows: [],
        };
        brand.products.set(row.productId, product);
      }

      const salableQty = Number(row.salableQty);
      const unsalableQty = Number(row.unsalableQty);
      const totalQty = salableQty + unsalableQty;
      brand.totalQty += totalQty;
      brand.salableQty += salableQty;
      brand.unsalableQty += unsalableQty;
      product.totalQty += totalQty;
      product.salableQty += salableQty;
      product.unsalableQty += unsalableQty;
      product.rows.push(row);
    }

    return [...brandMap.values()].map((brand) => ({
      ...brand,
      products: [...brand.products.values()],
    }));
  }, [pagination.pageRows]);

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <h2 className="text-lg font-semibold text-slate-950">库存明细</h2>
        <div className="grid w-full grid-cols-1 gap-3 sm:flex sm:w-auto sm:flex-nowrap sm:items-center sm:justify-end">
          <ProductFilterControls
            brands={brandOptions}
            products={productOptions}
            filters={filters}
            onFilterChange={onFilterChange}
            onFilterApply={onFilterApply}
          />
          <Button className="w-full sm:w-auto" onClick={onExport}>导出</Button>
        </div>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-3 md:hidden">
          {mobileGroups.map((brand) => (
            <div key={brand.brandId} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b bg-slate-50 px-3 py-2">
                <div>
                  <h3 className="font-semibold text-slate-950">{brand.brandName}</h3>
                  <p className="text-xs text-slate-500">可售 {brand.salableQty}</p>
                </div>
                <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">总 {brand.totalQty}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {brand.products.map((product) => (
                  <div key={product.productId} className="p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-slate-900">{product.productName}</h4>
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">总 {product.totalQty}</span>
                    </div>
                    <table className="w-full table-fixed border-collapse text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500">
                          <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">规格名</th>
                          <th className="w-16 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">可售</th>
                          <th className="w-14 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">总</th>
                          <th className="w-12 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {product.rows.map((row) => {
                          const salable = Number(row.salableQty);
                          const unsalable = Number(row.unsalableQty);
                          return (
                            <tr key={row.skuId}>
                              <td className="break-words border border-slate-200 px-2 py-1.5">{row.skuName}</td>
                              <td className={["border border-slate-200 px-2 py-1.5", salable === 0 ? "bg-red-50 font-semibold text-red-700" : salable === 1 ? "bg-amber-50 font-semibold text-amber-700" : ""].join(" ")}>{salable}</td>
                              <td className="border border-slate-200 px-2 py-1.5">{salable + unsalable}</td>
                              <td className="border border-slate-200 px-2 py-1.5 text-center">
                                {canWrite && unsalable > 0 && (
                                  <button type="button" title="调整不可售库存" aria-label="调整不可售库存" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-blue-600 hover:bg-blue-50" onClick={() => onAdjust(row)}>
                                    <PencilLine className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
          <table className={`${tableBase} min-w-[900px]`}>
            <thead>
              <tr>
                <th className={thBase}>品牌名</th>
                <th className={thBase}>商品名</th>
                <th className={thBase}>规格名</th>
                <th className={thBase}>库存总量</th>
                <th className={thBase}>可售库存数</th>
                <th className={thBase}>操作</th>
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
                    <td className={tdBase}>
                      {canWrite && Number(row.unsalableQty) > 0 && (
                        <button type="button" title="调整不可售库存" aria-label="调整不可售库存" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-blue-600 hover:bg-blue-50" onClick={() => onAdjust(row)}>
                          <PencilLine className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
  catalogRows,
  canWrite,
  onPageChange,
  onFilterChange,
  onFilterApply,
  onExport,
  onRevoke,
  onResolve,
  onReset,
  onInbound,
  onOutbound,
  onAbnormal,
}: {
  logs: InventoryLog[];
  page: number;
  total: number;
  filters: InventoryLogFilters;
  catalogRows: SkuInventoryRow[];
  canWrite: boolean;
  onPageChange: (page: number) => void;
  onFilterChange: (filters: InventoryLogFilters) => void;
  onFilterApply: (filters: InventoryLogFilters) => void;
  onExport: () => void;
  onRevoke: (log: InventoryLog) => void;
  onResolve: (log: InventoryLog, skuId: number) => void;
  onReset: () => void;
  onInbound: () => void;
  onOutbound: () => void;
  onAbnormal: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [orderDialog, setOrderDialog] = useState<InventoryLog | null>(null);
  const [resolveSkuId, setResolveSkuId] = useState("");
  const [resolveBrandId, setResolveBrandId] = useState("");
  const [resolveProductId, setResolveProductId] = useState("");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, (page - 1) * pageSize + logs.length);
  const brandOptions = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of catalogRows) map.set(row.brandId, row.brandName);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [catalogRows]);
  const productOptions = useMemo(() => {
    const map = new Map<number, { id: number; brandId: number; name: string }>();
    for (const row of catalogRows) {
      if (resolveBrandId && row.brandId !== Number(resolveBrandId)) continue;
      map.set(row.productId, { id: row.productId, brandId: row.brandId, name: row.productName });
    }
    return [...map.values()];
  }, [catalogRows, resolveBrandId]);

  function openOrderDialog(log: InventoryLog) {
    setOrderDialog(log);
    setResolveBrandId(log.brandId ? String(log.brandId) : "");
    setResolveProductId(log.productId ? String(log.productId) : "");
    setResolveSkuId("");
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  function patchFilters(patch: Partial<InventoryLogFilters>) {
    const nextFilters = { ...filters, ...patch };
    onFilterChange(nextFilters);
    onFilterApply(nextFilters);
  }

  function renderRevokeAction(log: InventoryLog) {
    const createdAt = parseLocalDateTime(String(log.createdAt));
    const remaining = 10 * 60 * 1000 - (now - createdAt);
    if (!canWrite || !log.canRevoke || !createdAt || remaining <= 0) return <span className="text-slate-400">-</span>;
    return <ActionLink onClick={() => onRevoke(log)}>撤销({formatRevokeCountdown(remaining)})</ActionLink>;
  }

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">库存操作</h2>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onOutbound}>出库</Button>
            <Button onClick={onInbound}>入库</Button>
            <Button className="bg-yellow-400 text-yellow-950 hover:bg-yellow-500 focus-visible:ring-yellow-500" onClick={onAbnormal}>异常库存</Button>
          </div>
        )}
      </div>
      <div className="border-b bg-slate-50/60 p-3 sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-center">
          <DateRangePicker2
            filters={filters}
            onChange={(next) => patchFilters({ startAt: next.startAt, endAt: next.endAt })}
            onClear={onReset}
          />
          <Select
            className={["h-10 w-full sm:w-28", filters.operationType ? "" : "text-slate-400"].join(" ")}
            value={filters.operationType}
            onChange={(event) => patchFilters({ operationType: event.target.value as InventoryLogFilters["operationType"] })}
          >
            <option className="text-slate-400" value="">全部类型</option>
            <option className="text-slate-800" value="1">入库</option>
            <option className="text-slate-800" value="2">出库</option>
          </Select>
          <Select
            className={["h-10 w-full sm:w-36", filters.brandId ? "" : "text-slate-400"].join(" ")}
            value={String(filters.brandId || "")}
            onChange={(event) => patchFilters({ brandId: event.target.value ? Number(event.target.value) : "", productId: "" })}
          >
            <option className="text-slate-400" value="">全部品牌</option>
            {brandOptions.map((brand) => <option className="text-slate-800" key={brand.id} value={brand.id}>{brand.name}</option>)}
          </Select>
          <Select
            className={["h-10 w-full sm:w-36", filters.productId ? "" : "text-slate-400"].join(" ")}
            value={String(filters.productId || "")}
            onChange={(event) => patchFilters({ productId: event.target.value ? Number(event.target.value) : "" })}
          >
            <option className="text-slate-400" value="">全部商品</option>
            {productOptions.map((product) => <option className="text-slate-800" key={product.id} value={product.id}>{product.name}</option>)}
          </Select>
          <Select
            className={["h-10 w-full sm:w-28", filters.inboundType ? "" : "text-slate-400"].join(" ")}
            value={filters.inboundType}
            onChange={(event) => patchFilters({ inboundType: event.target.value as InventoryLogFilters["inboundType"] })}
          >
            <option className="text-slate-400" value="">全部入库类型</option>
            <option className="text-slate-800" value="1">新货</option>
            <option className="text-slate-800" value="2">退货</option>
          </Select>
          <Select
            className={["h-10 w-full sm:w-28", filters.platform ? "" : "text-slate-400"].join(" ")}
            value={filters.platform}
            onChange={(event) => patchFilters({ platform: event.target.value as InventoryLogFilters["platform"] })}
          >
            <option className="text-slate-400" value="">全部平台</option>
            {platformOptions.map((option) => <option className="text-slate-800" key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
          <Button className="w-full sm:w-auto" onClick={onExport}>导出</Button>
        </div>
      </div>
      <div className="p-3 sm:p-5">
        <div className="grid gap-3 md:hidden">
          {logs.map((log) => (
            <article key={log.id} className={`rounded-lg border p-3 shadow-sm ${log.isBug ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">{String(log.createdAt).replace("T", " ").slice(0, 19)}</p>
                  <h3 className="mt-1 font-semibold text-slate-950">{log.brandName} · {log.productName}</h3>
                  <p className="text-sm text-slate-600">{log.skuName}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <OperationTypeBadge value={log.operationType} />
                  {renderRevokeAction(log)}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <InfoLine label="数量" value={log.quantity} />
                <InfoLine label="平台" value={platformLabel(log.platform) || "-"} />
                <InfoLine label="维修" value={log.isRepair ? "已维修" : "-"} />
                <InfoLine label="入库类型" value={log.operationType === 1 ? <InboundTypeText value={log.inboundType} /> : "-"} />
                <InfoLine label="操作人" value={log.operatorName} />
                <InfoLine label="备注" value={log.remark || "-"} />
                {log.orderId && <InfoLine label="订单编号" value={log.orderId} />}
                {log.shopName && <InfoLine label="店铺名" value={log.shopName} />}
                {log.shopIncome != null && <InfoLine label="实收金额" value={`¥${Number(log.shopIncome).toFixed(2)}`} />}
              </div>
              {log.isBug ? <ActionLink onClick={() => openOrderDialog(log)}>补全商品信息</ActionLink> : log.orderId ? <ActionLink onClick={() => setOrderDialog(log)}>关联订单</ActionLink> : null}
            </article>
          ))}
        </div>
        <div className="hidden overflow-auto md:block">
        <table className={`${tableBase} min-w-[980px]`}>
          <thead>
            <tr>
              <th className={thBase}>时间</th>
              <th className={thBase}>类型</th>
              <th className={thBase}>品牌名</th>
              <th className={thBase}>商品名</th>
              <th className={thBase}>规格名</th>
              <th className={thBase}>入库类型</th>
              <th className={thBase}>维修</th>
              <th className={thBase}>平台</th>
              <th className={thBase}>数量</th>
              <th className={thBase}>操作人</th>
              <th className={thBase}>备注</th>
              <th className={actionTh}>操作</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className={log.isBug ? "bg-red-50" : undefined}>
                <td className={tdBase}>{String(log.createdAt).replace("T", " ").slice(0, 19)}</td>
                <td className={tdBase}><OperationTypeBadge value={log.operationType} /></td>
                <td className={tdBase}>{log.brandName}</td>
                <td className={tdBase}>{log.productName}</td>
                <td className={tdBase}>{log.skuName}</td>
                <td className={tdBase}>{log.operationType === 1 ? <InboundTypeText value={log.inboundType} /> : ""}</td>
                <td className={tdBase}>{log.isRepair ? "已维修" : "-"}</td>
                <td className={tdBase}>{platformLabel(log.platform)}</td>
                <td className={tdBase}>{log.quantity}</td>
                <td className={tdBase}>{log.operatorName}</td>
                <td className={tdBase}>{log.remark || "-"}</td>
                <td className={actionTd}>
                  <div className="flex flex-wrap items-center gap-2">{renderRevokeAction(log)}{log.isBug ? <ActionLink onClick={() => openOrderDialog(log)}>补全商品信息</ActionLink> : log.orderId ? <ActionLink onClick={() => setOrderDialog(log)}>关联订单</ActionLink> : null}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      {orderDialog && <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 sm:items-center sm:p-4">
        <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-4 flex items-center justify-between"><h3 className="text-lg font-semibold">{orderDialog.isBug ? "补全商品信息" : "关联订单"}</h3><Button variant="ghost" size="sm" onClick={() => setOrderDialog(null)}>关闭</Button></div>
          <div className="grid gap-3">
            <InfoLine label="订单编号" value={orderDialog.orderId || "-"} />
            <InfoLine label="店铺名" value={orderDialog.shopName || "-"} />
            <InfoLine label="实收金额" value={orderDialog.shopIncome == null ? "-" : `¥${Number(orderDialog.shopIncome).toFixed(2)}`} />
            {!orderDialog.isBug && <>
              <InfoLine label="品牌名" value={orderDialog.brandName || "-"} />
              <InfoLine label="商品名" value={orderDialog.productName || "-"} />
              <InfoLine label="规格名" value={orderDialog.skuName || "-"} />
            </>}
            {orderDialog.isBug && <>
              <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">原商品信息：{orderDialog.sourceProductText || "-"}</p>
              <Field label="品牌名"><Select value={resolveBrandId} onChange={(event) => { setResolveBrandId(event.target.value); setResolveProductId(""); setResolveSkuId(""); }}><option value="">请选择品牌</option>{brandOptions.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</Select></Field>
              <Field label="商品名"><Select value={resolveProductId} disabled={!resolveBrandId} onChange={(event) => { setResolveProductId(event.target.value); setResolveSkuId(""); }}><option value="">请选择商品</option>{productOptions.filter((product) => product.brandId === Number(resolveBrandId)).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</Select></Field>
              <Field label="规格名"><Select value={resolveSkuId} disabled={!resolveProductId} onChange={(event) => setResolveSkuId(event.target.value)}><option value="">请选择规格</option>{catalogRows.filter((row) => row.brandId === Number(resolveBrandId) && row.productId === Number(resolveProductId)).map((row) => <option key={row.skuId} value={row.skuId}>{row.skuName}</option>)}</Select></Field>
              <div className="flex justify-end"><Button disabled={!resolveSkuId} onClick={() => { onResolve(orderDialog, Number(resolveSkuId)); setOrderDialog(null); }}>确认补全并出库</Button></div>
            </>}
          </div>
        </div>
      </div>}
        <PaginationBar page={page} totalPages={totalPages} start={start} end={end} total={total} onPageChange={onPageChange} />
      </div>
    </section>
  );
}

function InventoryCheckPage({ token, canUpload, onInventoryChanged }: { token: string; canUpload: boolean; onInventoryChanged: () => void }) {
  const [records, setRecords] = useState<InventoryCheckRecord[]>([]);
  const [abnormalLogs, setAbnormalLogs] = useState<InventoryAbnormalLog[]>([]);
  const [abnormalTotal, setAbnormalTotal] = useState(0);
  const [abnormalPage, setAbnormalPage] = useState(1);
  const [abnormalDateRange, setAbnormalDateRange] = useState({ startAt: "", endAt: "" });
  const [isExportingAbnormal, setIsExportingAbnormal] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<InventoryCheckRecord | null>(null);
  const [detailRows, setDetailRows] = useState<InventoryCheckDifference[]>([]);
  const [loading, setLoading] = useState(false);
  const [isUploadProcessing, setIsUploadProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abnormalRequestId = useRef(0);
  const recordPagination = usePagination(records, 5);
  const detailPagination = usePagination(detailRows);
  const abnormalPageSize = 20;
  const abnormalStart = abnormalTotal ? (abnormalPage - 1) * abnormalPageSize + 1 : 0;
  const abnormalEnd = Math.min(abnormalTotal, (abnormalPage - 1) * abnormalPageSize + abnormalLogs.length);
  const abnormalTotalPages = Math.max(1, Math.ceil(abnormalTotal / abnormalPageSize));

  async function loadRecords() {
    setLoading(true);
    setError("");
    try {
      setRecords(await api.inventoryChecks(token));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "盘点记录加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadAbnormalLogs(nextPage = abnormalPage, range = abnormalDateRange) {
    const requestId = ++abnormalRequestId.current;
    setError("");
    try {
      const result = await api.abnormalLogs(token, nextPage, abnormalPageSize, range);
      if (requestId !== abnormalRequestId.current) return;
      setAbnormalLogs(result.rows);
      setAbnormalTotal(result.total);
      setAbnormalPage(nextPage);
    } catch (nextError) {
      if (requestId === abnormalRequestId.current) {
        setError(nextError instanceof Error ? nextError.message : "异常库存记录加载失败");
      }
    }
  }

  async function exportAbnormalLogs() {
    setIsExportingAbnormal(true);
    setError("");
    try {
      const blob = await api.exportAbnormalLogs(token, abnormalDateRange);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `异常库存记录_${abnormalDateRange.startAt || "不限"}_至_${abnormalDateRange.endAt || "不限"}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "异常库存记录导出失败");
    } finally {
      setIsExportingAbnormal(false);
    }
  }

  useEffect(() => {
    void loadRecords();
  }, [token]);

  useEffect(() => {
    void loadAbnormalLogs(1, abnormalDateRange);
  }, [token, abnormalDateRange]);

  async function openDetail(id: number) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const result = await api.inventoryCheckDetail(token, id);
      setSelectedRecord(result.record);
      setDetailRows(result.rows);
      detailPagination.setPage(1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "盘点详情加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function downloadTemplate() {
    setError("");
    try {
      const blob = await api.inventoryCheckTemplate(token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `库存盘点模板-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "模板下载失败");
    }
  }

  async function downloadCheckFile(record: InventoryCheckRecord) {
    setError("");
    try {
      const blob = await api.inventoryCheckFile(token, record.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `盘点数据-${record.checkTime.replace(/[^\d]/g, "").slice(0, 14)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "盘点数据下载失败");
    }
  }

  async function exportCheckDetail(record: InventoryCheckRecord) {
    setError("");
    try {
      const blob = await api.exportInventoryCheckDetail(token, record.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `盘点详情-${record.checkTime.replace(/[^\d]/g, "").slice(0, 14)}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "盘点详情导出失败");
    }
  }

  async function syncCheckDifferences(record: InventoryCheckRecord) {
    if (!window.confirm("确定将本次盘点差异同步到真实库存吗？")) return;
    setIsSyncing(true);
    setError("");
    setMessage("");
    try {
      const result = await api.syncInventoryCheck(token, record.id);
      setSelectedRecord(result.record);
      setDetailRows(result.rows);
      setMessage("库存盘点差异已同步");
      await loadRecords();
      await loadAbnormalLogs(1);
      onInventoryChanged();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "库存盘点差异同步失败");
    } finally {
      setIsSyncing(false);
    }
  }

  async function uploadCheck(file: File) {
    setLoading(true);
    setIsUploadProcessing(true);
    setError("");
    setMessage("");
    try {
      const result = await api.uploadInventoryCheck(token, file);
      setSelectedRecord(result.record);
      setDetailRows(result.rows);
      setMessage(`上传成功，本次盘点发现 ${result.rows.length} 条差异`);
      await loadRecords();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "盘点上传失败");
    } finally {
      setIsUploadProcessing(false);
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const uploadProcessingOverlay = isUploadProcessing ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40">
      <div className="flex items-center gap-3 rounded-lg bg-white px-5 py-4 text-sm font-medium text-slate-700 shadow-xl">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
        正在处理盘点数据，请稍候...
      </div>
    </div>
  ) : null;

  if (selectedRecord) {
    return (
      <>
        {uploadProcessingOverlay}
        <section className="rounded-lg border bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">盘点详情</h2>
              <p className="mt-1 text-sm text-slate-500">
                {selectedRecord.checkTime} · {selectedRecord.operatorName} · 差异 {selectedRecord.differenceCount} 条
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canUpload && Boolean(selectedRecord.canSync) && detailRows.length > 0 && (
                <Button
                  className="bg-yellow-400 text-yellow-950 hover:bg-yellow-500 focus-visible:ring-yellow-500"
                  onClick={() => void syncCheckDifferences(selectedRecord)}
                  disabled={isSyncing}
                >
                  {isSyncing ? "同步中" : "同步差异库存"}
                </Button>
              )}
              <Button onClick={() => void exportCheckDetail(selectedRecord)}>导出</Button>
              <Button variant="secondary" onClick={() => {
                setSelectedRecord(null);
                setDetailRows([]);
              }}>返回列表</Button>
            </div>
          </div>
          {message && <p className="m-5 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</p>}
          {error && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <div className="p-3 sm:p-5">
            <div className="grid gap-3 md:hidden">
              {detailPagination.pageRows.map((row) => (
                <article key={row.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="mb-3">
                    <h3 className="font-semibold text-slate-950">{row.brandName} · {row.productName}</h3>
                    <p className="text-sm text-slate-500">{row.skuName}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center text-sm">
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">系统可售</p>
                      <p className="font-semibold">{row.systemSalableQty}</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">实际可售</p>
                      <p className="font-semibold">{row.actualSalableQty}</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">系统不可售</p>
                      <p className="font-semibold">{row.systemUnsalableQty}</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <p className="text-xs text-slate-500">实际不可售</p>
                      <p className="font-semibold">{row.actualUnsalableQty}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md border border-slate-200 p-2">
                      <p className="text-xs text-slate-500">可售差值</p>
                      <p className={diffClass(row.salableDiffQty)}>{formatSigned(row.salableDiffQty)}</p>
                      <p className={["text-xs", diffClass(row.salableDiffQty)].join(" ")}>{formatMoney(row.salableDiffAmount)}</p>
                    </div>
                    <div className="rounded-md border border-slate-200 p-2">
                      <p className="text-xs text-slate-500">不可售差值</p>
                      <p className={diffClass(row.unsalableDiffQty)}>{formatSigned(row.unsalableDiffQty)}</p>
                      <p className={["text-xs", diffClass(row.unsalableDiffQty)].join(" ")}>{formatMoney(row.unsalableDiffAmount)}</p>
                    </div>
                  </div>
                </article>
              ))}
              {!detailRows.length && <p className="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">本次盘点没有差异</p>}
            </div>
            <div className="hidden overflow-auto md:block">
            <table className={`${tableBase} min-w-[1380px]`}>
              <thead>
                <tr>
                  <th className={thBase}>品牌名</th>
                  <th className={thBase}>商品名</th>
                  <th className={thBase}>规格名</th>
                  <th className={thBase}>可售库存数</th>
                  <th className={thBase}>不可售库存数</th>
                  <th className={thBase}>实际可售库存数</th>
                  <th className={thBase}>实际不可售库存数</th>
                  <th className={thBase}>可售库存数差值</th>
                  <th className={thBase}>可售差值金额</th>
                  <th className={thBase}>不可售库存数差值</th>
                  <th className={thBase}>不可售差值金额</th>
                </tr>
              </thead>
              <tbody>
                {detailPagination.pageRows.map((row, index) => {
                  const brandSpan = rowSpanFor(detailPagination.pageRows, index, (item) => item.brandName);
                  const productSpan = rowSpanFor(detailPagination.pageRows, index, (item) => `${item.brandName}-${item.productName}`);
                  return (
                    <tr key={row.id}>
                      {brandSpan > 0 && <td className={`${tdBase} text-center font-medium`} rowSpan={brandSpan}>{row.brandName}</td>}
                      {productSpan > 0 && <td className={`${tdBase} text-center`} rowSpan={productSpan}>{row.productName}</td>}
                      <td className={tdBase}>{row.skuName}</td>
                      <td className={tdBase}>{row.systemSalableQty}</td>
                      <td className={tdBase}>{row.systemUnsalableQty}</td>
                      <td className={tdBase}>{row.actualSalableQty}</td>
                      <td className={tdBase}>{row.actualUnsalableQty}</td>
                      <td className={[tdBase, diffClass(row.salableDiffQty)].join(" ")}>{formatSigned(row.salableDiffQty)}</td>
                      <td className={[tdBase, diffClass(row.salableDiffQty)].join(" ")}>{formatMoney(row.salableDiffAmount)}</td>
                      <td className={[tdBase, diffClass(row.unsalableDiffQty)].join(" ")}>{formatSigned(row.unsalableDiffQty)}</td>
                      <td className={[tdBase, diffClass(row.unsalableDiffQty)].join(" ")}>{formatMoney(row.unsalableDiffAmount)}</td>
                    </tr>
                  );
                })}
                {!detailRows.length && (
                  <tr>
                    <td className={`${tdBase} text-center text-slate-500`} colSpan={11}>本次盘点没有差异</td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
            <PaginationBar {...detailPagination} onPageChange={detailPagination.setPage} />
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {uploadProcessingOverlay}
      <section className="rounded-lg border bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <h2 className="text-lg font-semibold text-slate-950">库存盘点</h2>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void downloadTemplate()}>下载模板</Button>
            {canUpload && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadCheck(file);
                  }}
                />
                <Button onClick={() => fileInputRef.current?.click()} disabled={loading}>上传数据</Button>
              </>
            )}
          </div>
        </div>
        {message && <p className="m-5 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</p>}
        {error && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="p-3 sm:p-5">
          <div className="grid gap-3 md:hidden">
            {recordPagination.pageRows.map((record) => (
              <article key={record.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-slate-950">{record.checkTime}</h3>
                    <p className="text-sm text-slate-500">{record.operatorName}</p>
                  </div>
                  <span className="rounded-md bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-700">差异 {record.differenceCount}</span>
                </div>
                <div className="flex justify-end gap-3">
                  <ActionLink onClick={() => void openDetail(record.id)}>查看详情</ActionLink>
                  {record.uploadFilePath ? <ActionLink onClick={() => void downloadCheckFile(record)}>下载</ActionLink> : <span className="text-sm text-slate-400">-</span>}
                </div>
              </article>
            ))}
            {!records.length && <p className="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">暂无盘点记录</p>}
          </div>
          <div className="hidden overflow-auto md:block">
          <table className={`${tableBase} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thBase}>盘点时间</th>
                <th className={thBase}>差异数量</th>
                <th className={thBase}>操作人</th>
                <th className={actionTh}>查看详情</th>
                <th className={actionTh}>下载盘点数据</th>
              </tr>
            </thead>
            <tbody>
              {recordPagination.pageRows.map((record) => (
                <tr key={record.id}>
                  <td className={tdBase}>{record.checkTime}</td>
                  <td className={tdBase}>{record.differenceCount}</td>
                  <td className={tdBase}>{record.operatorName}</td>
                  <td className={actionTd}><ActionLink onClick={() => void openDetail(record.id)}>查看详情</ActionLink></td>
                  <td className={actionTd}>
                    {record.uploadFilePath ? <ActionLink onClick={() => void downloadCheckFile(record)}>下载</ActionLink> : <span className="text-slate-400">-</span>}
                  </td>
                </tr>
              ))}
              {!records.length && (
                <tr>
                  <td className={`${tdBase} text-center text-slate-500`} colSpan={5}>暂无盘点记录</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
          <PaginationBar {...recordPagination} onPageChange={recordPagination.setPage} />
        </div>
      </section>

      <section className="rounded-lg border bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
          <h2 className="text-lg font-semibold text-slate-950">异常库存记录</h2>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <DateRangePicker2
              filters={abnormalDateRange}
              onChange={setAbnormalDateRange}
              onClear={() => {
                setAbnormalDateRange({ startAt: "", endAt: "" });
              }}
            />
            <Button onClick={() => void exportAbnormalLogs()} disabled={isExportingAbnormal}>
              <Download className="mr-2 h-4 w-4" />{isExportingAbnormal ? "导出中" : "导出"}
            </Button>
          </div>
        </div>
        <div className="p-3 sm:p-5">
          <div className="grid gap-3 md:hidden">
            {abnormalLogs.map((log) => (
              <article key={log.id} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">{log.createdAt}</p>
                    <h3 className="mt-1 font-semibold text-slate-950">{log.brandName} · {log.productName}</h3>
                    <p className="text-sm text-slate-600">{log.skuName}</p>
                  </div>
                  <span className={["shrink-0 rounded-md px-2 py-1 text-sm font-semibold", Number(log.quantity) > 0 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"].join(" ")}>
                    <AbnormalQuantityText log={log} />
                  </span>
                </div>
                <div className="space-y-2">
                  <InfoLine label="原因" value={log.reason} />
                  <InfoLine label="操作人" value={log.operatorName} />
                </div>
              </article>
            ))}
            {!abnormalLogs.length && <p className="rounded-lg border border-slate-200 p-4 text-center text-sm text-slate-500">暂无异常库存记录</p>}
          </div>
          <div className="hidden overflow-auto md:block">
            <table className={`${tableBase} min-w-[920px]`}>
              <thead>
                <tr>
                  <th className={thBase}>时间</th>
                  <th className={thBase}>品牌名</th>
                  <th className={thBase}>商品名</th>
                  <th className={thBase}>规格名</th>
                  <th className={thBase}>数量</th>
                  <th className={thBase}>原因</th>
                  <th className={thBase}>操作人</th>
                </tr>
              </thead>
              <tbody>
                {abnormalLogs.map((log) => (
                  <tr key={log.id}>
                    <td className={tdBase}>{log.createdAt}</td>
                    <td className={tdBase}>{log.brandName}</td>
                    <td className={tdBase}>{log.productName}</td>
                    <td className={tdBase}>{log.skuName}</td>
                    <td className={[tdBase, Number(log.quantity) > 0 ? "font-semibold text-green-700" : "font-semibold text-red-700"].join(" ")}><AbnormalQuantityText log={log} /></td>
                    <td className={tdBase}>{log.reason}</td>
                    <td className={tdBase}>{log.operatorName}</td>
                  </tr>
                ))}
                {!abnormalLogs.length && (
                  <tr>
                    <td className={`${tdBase} text-center text-slate-500`} colSpan={7}>暂无异常库存记录</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <PaginationBar
            page={abnormalPage}
            totalPages={abnormalTotalPages}
            start={abnormalStart}
            end={abnormalEnd}
            total={abnormalTotal}
            onPageChange={(nextPage) => void loadAbnormalLogs(nextPage)}
          />
        </div>
      </section>
    </>
  );
}

function formatSigned(value: number) {
  const numeric = Number(value || 0);
  return numeric > 0 ? `+${numeric}` : String(numeric);
}

function diffClass(value: number) {
  const numeric = Number(value || 0);
  if (numeric > 0) return "font-semibold text-green-700";
  if (numeric < 0) return "font-semibold text-red-700";
  return "";
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
        <div className="border-b p-4 sm:p-5">
          <h2 className="text-lg font-semibold text-slate-950">数据统计</h2>
        </div>
        {statsError && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{statsError}</p>}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-lg border bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-base font-semibold text-slate-950">品牌商品销量 Top5</h3>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
              <Select className="w-full sm:w-28" value={String(brandId || "")} onChange={(event) => setBrandId(Number(event.target.value))}>
                {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </Select>
              <Select className="w-full sm:w-24" value={String(brandDays)} onChange={(event) => setBrandDays(Number(event.target.value))}>
                <option value="7">7天</option>
                <option value="15">15天</option>
                <option value="30">30天</option>
              </Select>
            </div>
          </div>
          <EChart option={brandSalesOption} className="h-[300px] sm:h-[360px]" />
        </section>

        <section className="rounded-lg border bg-white p-4 shadow-sm sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-base font-semibold text-slate-950">全部商品销量 Top10</h3>
            <div className="grid gap-2 sm:flex sm:shrink-0">
              <Select className="w-full sm:w-24" value={String(topDays)} onChange={(event) => setTopDays(Number(event.target.value))}>
                <option value="7">7天</option>
                <option value="15">15天</option>
                <option value="30">30天</option>
              </Select>
            </div>
          </div>
          <EChart option={topSalesOption} className="h-[300px] sm:h-[360px]" />
        </section>
      </div>

      <section className="rounded-lg border bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-base font-semibold text-slate-950">总销量趋势</h3>
          <div className="grid gap-2 sm:flex sm:shrink-0">
            <Select className="w-full sm:w-36" value={trendPeriod} onChange={(event) => setTrendPeriod(event.target.value)}>
              <option value="day">日（15日内）</option>
              <option value="week">周（8周）</option>
              <option value="month">月（6个月内）</option>
            </Select>
            <details className="relative">
              <summary className="flex h-10 w-full cursor-pointer list-none items-center justify-between rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 sm:w-40">
                已选 {trendBrandIds.length || brands.length} 个品牌
              </summary>
              <div className="absolute right-0 z-20 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white p-3 shadow-lg">
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
        <EChart option={trendOption} className="h-[300px] sm:h-[380px]" />
      </section>
    </section>
  );
}

function formatMoney(value: number) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function PlatformAmountBreakdown({ amounts }: { amounts?: Record<Exclude<PlatformValue, ""> | "none", number> }) {
  if (!amounts) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs font-normal text-slate-500">
      <div>拼多多：{formatMoney(amounts.pinduoduo || 0)}</div>
      <div>抖音：{formatMoney(amounts.douyin || 0)}</div>
      <div>快手：{formatMoney(amounts.kuaishou || 0)}</div>
      <div>闲鱼：{formatMoney(amounts.xianyu || 0)}</div>
      <div>微信：{formatMoney(amounts.wechat || 0)}</div>
      <div>视频号：{formatMoney(amounts.video_account || 0)}</div>
      {Number(amounts.none || 0) !== 0 && <div>未选择：{formatMoney(amounts.none || 0)}</div>}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 text-right text-slate-900">{value}</span>
    </div>
  );
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
  salableQty?: number;
  unsalableQty?: number;
  salableAmount?: number;
  unsalableAmount?: number;
  brandPlatformAmounts?: {
    douyin: number;
    pinduoduo: number;
    kuaishou: number;
    xianyu: number;
    wechat: number;
    video_account: number;
    none: number;
  };
};

function AmountDetailText({ children }: { children: React.ReactNode }) {
  return <span className="ml-1 text-xs font-normal text-slate-500">{children}</span>;
}

function InventoryQuantityCell({ row }: { row: AmountRow }) {
  const unsalableQty = Number(row.unsalableQty || 0);
  return (
    <span>
      {row.quantity}
      {unsalableQty > 0 && <AmountDetailText>（{Number(row.salableQty || 0)}可售；{unsalableQty}不可售）</AmountDetailText>}
    </span>
  );
}

function InventoryAmountCell({ amount, salableAmount, unsalableAmount }: { amount: number; salableAmount?: number; unsalableAmount?: number }) {
  const unsalable = Number(unsalableAmount || 0);
  return (
    <span>
      {formatMoney(amount)}
      {unsalable > 0 && <AmountDetailText>（{formatMoney(Number(salableAmount || 0))}可售；{formatMoney(unsalable)}不可售）</AmountDetailText>}
    </span>
  );
}

function AmountTable({
  rows,
  quantityTitle,
  amountTitle,
  showPlatformBreakdown = false,
  showInventoryBreakdown = false,
}: {
  rows: AmountRow[];
  quantityTitle: string;
  amountTitle: string;
  showPlatformBreakdown?: boolean;
  showInventoryBreakdown?: boolean;
}) {
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
  const brandInventoryBreakdowns = useMemo(() => {
    const totals = new Map<number, { salableAmount: number; unsalableAmount: number }>();
    for (const row of rows) {
      const current = totals.get(row.brandId) || { salableAmount: 0, unsalableAmount: 0 };
      current.salableAmount += Number(row.salableAmount || 0);
      current.unsalableAmount += Number(row.unsalableAmount || 0);
      totals.set(row.brandId, current);
    }
    return totals;
  }, [rows]);
  const brandPlatformAmounts = useMemo(() => {
    const amounts = new Map<number, NonNullable<AmountRow["brandPlatformAmounts"]>>();
    for (const row of rows) {
      if (row.brandPlatformAmounts && !amounts.has(row.brandId)) amounts.set(row.brandId, row.brandPlatformAmounts);
    }
    return amounts;
  }, [rows]);
  const mobileBrandGroups = useMemo(() => {
    const groups = new Map<number, {
      brandId: number;
      brandName: string;
      totalAmount: number;
      salableAmount: number;
      unsalableAmount: number;
      platformAmounts?: NonNullable<AmountRow["brandPlatformAmounts"]>;
      products: typeof productGroups;
    }>();

    for (const group of pageGroups) {
      const current = groups.get(group.brandId) || {
        brandId: group.brandId,
        brandName: group.brandName,
        totalAmount: brandTotals.get(group.brandId) || 0,
        salableAmount: brandInventoryBreakdowns.get(group.brandId)?.salableAmount || 0,
        unsalableAmount: brandInventoryBreakdowns.get(group.brandId)?.unsalableAmount || 0,
        platformAmounts: brandPlatformAmounts.get(group.brandId),
        products: [],
      };
      current.products.push(group);
      groups.set(group.brandId, current);
    }

    return [...groups.values()];
  }, [pageGroups, brandTotals, brandInventoryBreakdowns, brandPlatformAmounts, productGroups]);
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
    <div className="p-3 sm:p-5">
      <div className="grid gap-3 md:hidden">
        {mobileBrandGroups.map((brand) => (
          <div key={brand.brandId} className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="flex items-start justify-between gap-3 border-b bg-slate-50 px-3 py-2">
              <div>
                <h3 className="font-semibold text-slate-950">{brand.brandName}</h3>
                {showPlatformBreakdown && <PlatformAmountBreakdown amounts={brand.platformAmounts} />}
              </div>
              <span className="shrink-0 rounded-md bg-blue-50 px-2 py-1 text-sm font-semibold text-blue-700">
                <span className="block">{formatMoney(brand.totalAmount)}</span>
                {showInventoryBreakdown && brand.unsalableAmount > 0 && (
                  <span className="mt-0.5 block text-xs font-normal text-slate-500">
                    （{formatMoney(brand.salableAmount)}可售；{formatMoney(brand.unsalableAmount)}不可售）
                  </span>
                )}
              </span>
            </div>
            <div className="divide-y divide-slate-100">
              {brand.products.map((product) => {
                const expanded = expandedProducts.has(product.key);
                return (
                  <div key={product.key} className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 text-left font-semibold text-slate-900"
                        onClick={() => toggleProduct(product.key)}
                      >
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-300 text-slate-600">
                          {expanded ? <Minus className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        </span>
                        <span className="truncate">{product.productName}</span>
                      </button>
                      <span className="shrink-0 text-sm font-medium text-slate-900">{formatMoney(product.totalAmount)}</span>
                    </div>
                    {expanded && (
                      <table className="mt-2 w-full table-fixed border-collapse text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500">
                            <th className="border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">规格名</th>
                            <th className="w-20 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">{quantityTitle}</th>
                            <th className="w-24 border border-slate-200 bg-slate-50 px-2 py-1.5 font-medium">{amountTitle}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {product.rows.map((row) => (
                            <tr key={row.skuId}>
                              <td className="break-words border border-slate-200 px-2 py-1.5">{row.skuName}</td>
                              <td className="border border-slate-200 px-2 py-1.5">
                                {showInventoryBreakdown ? <InventoryQuantityCell row={row} /> : row.quantity}
                              </td>
                              <td className="border border-slate-200 px-2 py-1.5">
                                {showInventoryBreakdown ? (
                                  <InventoryAmountCell amount={row.amount} salableAmount={row.salableAmount} unsalableAmount={row.unsalableAmount} />
                                ) : formatMoney(row.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden overflow-auto md:block">
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
                  {brandSpan > 0 && (
                    <td className={tdBase} rowSpan={brandSpan}>
                      <div>{formatMoney(brandTotals.get(group.brandId) || 0)}</div>
                      {showInventoryBreakdown && Number(brandInventoryBreakdowns.get(group.brandId)?.unsalableAmount || 0) > 0 && (
                        <div className="mt-1 text-xs font-normal text-slate-500">
                          （{formatMoney(Number(brandInventoryBreakdowns.get(group.brandId)?.salableAmount || 0))}可售；{formatMoney(Number(brandInventoryBreakdowns.get(group.brandId)?.unsalableAmount || 0))}不可售）
                        </div>
                      )}
                      {showPlatformBreakdown && <PlatformAmountBreakdown amounts={brandPlatformAmounts.get(group.brandId)} />}
                    </td>
                  )}
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
                              <td className="border border-slate-200 bg-white px-3 py-2">
                                {showInventoryBreakdown ? <InventoryQuantityCell row={row} /> : row.quantity}
                              </td>
                              <td className="border border-slate-200 bg-white px-3 py-2">
                                {showInventoryBreakdown ? (
                                  <InventoryAmountCell amount={row.amount} salableAmount={row.salableAmount} unsalableAmount={row.unsalableAmount} />
                                ) : formatMoney(row.amount)}
                              </td>
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
      </div>
      <PaginationBar {...pagination} onPageChange={pagination.setPage} />
    </div>
  );
}

function InventoryAmountPage({ rows, token }: { rows: SkuInventoryRow[]; token: string }) {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const amountRows = useMemo<AmountRow[]>(
    () =>
      rows.map((row) => {
        const salableQty = Number(row.salableQty);
        const unsalableQty = Number(row.unsalableQty);
        const purchasePrice = Number(row.purchasePrice);
        const quantity = salableQty + unsalableQty;
        return {
          brandId: row.brandId,
          brandName: row.brandName,
          productId: row.productId,
          productName: row.productName,
          skuId: row.skuId,
          skuName: row.skuName,
          quantity,
          amount: quantity * purchasePrice,
          salableQty,
          unsalableQty,
          salableAmount: salableQty * purchasePrice,
          unsalableAmount: unsalableQty * purchasePrice,
        };
      }),
    [rows],
  );
  const totalAmount = useMemo(
    () => amountRows.reduce((sum, row) => sum + row.amount, 0),
    [amountRows],
  );

  async function exportInventoryAmount() {
    setExporting(true);
    try {
      const blob = await api.exportInventoryAmount(token);
      const now = new Date();
      const fileName = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${now.getHours()}时${now.getMinutes()}分_库存金额.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "库存金额导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <h2 className="text-lg font-semibold text-slate-950">库存金额</h2>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="text-sm font-medium text-slate-900">总金额：{formatMoney(totalAmount)}</div>
          <Button onClick={() => void exportInventoryAmount()} disabled={exporting}>{exporting ? "导出中" : "导出"}</Button>
        </div>
      </div>
      {error && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <AmountTable rows={amountRows} quantityTitle="库存总量" amountTitle="库存金额" showInventoryBreakdown />
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
  const [exporting, setExporting] = useState(false);

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
          brandPlatformAmounts: row.brandPlatformAmounts
            ? {
                douyin: Number(row.brandPlatformAmounts.douyin || 0),
                pinduoduo: Number(row.brandPlatformAmounts.pinduoduo || 0),
                kuaishou: Number(row.brandPlatformAmounts.kuaishou || 0),
                xianyu: Number(row.brandPlatformAmounts.xianyu || 0),
                wechat: Number(row.brandPlatformAmounts.wechat || 0),
                video_account: Number(row.brandPlatformAmounts.video_account || 0),
                none: Number(row.brandPlatformAmounts.none || 0),
              }
            : undefined,
        })));
        setError("");
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : "销售金额加载失败"));
  }, [token, startDate, endDate]);

  async function exportSalesAmount() {
    setExporting(true);
    try {
      const blob = await api.exportSalesAmount(token, startDate, endDate);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `销售金额-${startDate}-至-${endDate}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "销售金额导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold text-slate-950">销售金额</h2>
          <span className="text-xs text-slate-400">出库金额-退货入库金额</span>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:flex">
          <Input className="w-full sm:w-40" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <span className="text-sm text-slate-500">至</span>
          <Input className="w-full sm:w-40" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          <Button className="col-span-3 w-full sm:w-auto" onClick={() => void exportSalesAmount()} disabled={exporting}>{exporting ? "导出中" : "导出"}</Button>
        </div>
      </div>
      {error && <p className="m-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <AmountTable rows={rows} quantityTitle="销售数量" amountTitle="成本金额" showPlatformBreakdown />
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium text-slate-700 sm:flex-row sm:items-center sm:gap-3">
      <span className="shrink-0 text-slate-600 sm:w-28 sm:text-right">{label}</span>
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
    { value: "kuaishou", label: "快手" },
    { value: "xianyu", label: "闲鱼" },
    { value: "wechat", label: "微信" },
    { value: "video_account", label: "视频号" },
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
  const updateRow = (index: number, key: string, value: unknown) => {
    const rows = Array.isArray(form.rows) ? [...form.rows] : [];
    rows[index] = {
      ...rows[index],
      [key]: value,
      ...(key === "inboundType" && value !== "return" ? { isRepair: false } : {}),
    };
    onChange("rows", rows);
  };
  const addRow = (row: Record<string, unknown>) => onChange("rows", [...(Array.isArray(form.rows) ? form.rows : []), row]);
  const removeRow = (index: number) => onChange("rows", form.rows.filter((_: unknown, rowIndex: number) => rowIndex !== index));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-3 sm:items-center sm:p-4">
      <form onSubmit={onSubmit} className={`max-h-[calc(100vh-1.5rem)] w-full ${dialog === "inbound" || dialog === "outbound" ? "max-w-6xl" : dialog === "sku" && !editingId ? "max-w-4xl" : "max-w-xl"} overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:max-h-[calc(100vh-2rem)] sm:p-5`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{dialog === "inbound" ? "入库" : dialog === "outbound" ? "出库" : dialog === "abnormal" ? "异常库存" : editingId ? "修改" : "新增"}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </div>
        <div className="grid gap-3">
          {dialog === "user" && (
            <>
              <Field label="英文用户名"><Input value={form.username || ""} onChange={(event) => onChange("username", event.target.value)} required pattern="[A-Za-z][A-Za-z0-9_]{2,31}" /></Field>
              <Field label="邮箱"><Input type="email" value={form.email || ""} onChange={(event) => onChange("email", event.target.value)} /></Field>
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
              {editingId ? (
                <>
                  <Field label="规格名"><Input value={form.name || ""} onChange={(event) => onChange("name", event.target.value)} required maxLength={15} /></Field>
                  <Field label="购入价格"><Input type="number" min="0" step="0.01" value={form.purchasePrice || ""} onChange={(event) => onChange("purchasePrice", event.target.value)} required /></Field>
                  <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
                </>
              ) : (
                <Field label="规格行">
                  <div className="space-y-2">
                    <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5rem] gap-2 px-1 text-xs text-slate-500 sm:grid">
                      <span>规格名</span><span>购入价格</span><span>备注</span><span />
                    </div>
                    {(form.rows || []).map((row: Record<string, any>, index: number) => (
                      <div key={index} className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_5rem] sm:items-center sm:border-0 sm:p-0">
                        <Input className="min-w-0" placeholder="规格名" aria-label="规格名" value={row.name || ""} onChange={(event) => updateRow(index, "name", event.target.value)} required maxLength={15} />
                        <Input className="min-w-0" type="number" min="0" step="0.01" placeholder="购入价格" aria-label="购入价格" value={row.purchasePrice ?? ""} onChange={(event) => updateRow(index, "purchasePrice", event.target.value)} required />
                        <Input className="col-span-2 min-w-0 sm:col-span-1" placeholder="备注" aria-label="备注" value={row.remark || ""} onChange={(event) => updateRow(index, "remark", event.target.value)} />
                        <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
                          {form.rows.length > 1 && <Button type="button" variant="ghost" size="sm" aria-label="删除此行" onClick={() => removeRow(index)}><X className="h-4 w-4" /></Button>}
                          {index === form.rows.length - 1 && <Button type="button" variant="secondary" size="sm" aria-label="新增一行" onClick={() => addRow({ name: "", purchasePrice: "", remark: "" })}><Plus className="h-4 w-4" /></Button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Field>
              )}
            </>
          )}
          {(dialog === "inbound" || dialog === "outbound" || dialog === "abnormal") && (
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
              {(dialog === "inbound" || dialog === "outbound") ? (
                <Field label="规格行">
                  <div className="space-y-2">
                    <div className={`hidden gap-2 px-1 text-xs text-slate-500 sm:grid ${dialog === "inbound" ? "sm:grid-cols-[minmax(0,1.5fr)_5rem_6.5rem_5rem_7rem_minmax(7rem,1fr)_5rem]" : "sm:grid-cols-[minmax(0,1.35fr)_4.5rem_6.5rem_minmax(7rem,1fr)_6.5rem_minmax(7rem,1fr)_5rem]"}`}>
                      <span>规格名</span><span>数量</span>{dialog === "inbound" && <><span>类型</span><span>维修</span></>}<span>平台</span>{dialog === "outbound" && <><span>订单编号</span><span>实收金额</span></>}<span>备注</span><span />
                    </div>
                    {(form.rows || []).map((row: Record<string, any>, index: number) => (
                      <div key={index} className={`grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-2 sm:items-center sm:border-0 sm:p-0 ${dialog === "inbound" ? "sm:grid-cols-[minmax(0,1.5fr)_5rem_6.5rem_5rem_7rem_minmax(7rem,1fr)_5rem]" : "sm:grid-cols-[minmax(0,1.35fr)_4.5rem_6.5rem_minmax(7rem,1fr)_6.5rem_minmax(7rem,1fr)_5rem]"}`}>
                        <Select aria-label="规格名" className="col-span-2 min-w-0 sm:col-span-1" value={String(row.skuId || "")} onChange={(event) => updateRow(index, "skuId", event.target.value ? Number(event.target.value) : "")} required>
                          <option value="">请选择规格</option>{skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.name}</option>)}
                        </Select>
                        <Input aria-label="数量" type="number" min="1" step="1" value={row.quantity ?? 1} onChange={(event) => updateRow(index, "quantity", event.target.value)} required />
                        {dialog === "inbound" && <>
                          <Select aria-label="入库类型" value={row.inboundType || "new"} onChange={(event) => updateRow(index, "inboundType", event.target.value)}><option value="new">新货</option><option value="return">退货</option></Select>
                          <label className={`inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-md px-1 text-sm text-slate-700 ${row.inboundType === "return" ? "" : "invisible"}`}>
                            <input type="checkbox" checked={Boolean(row.isRepair)} onChange={(event) => updateRow(index, "isRepair", event.target.checked)} aria-label="维修" />
                            维修
                          </label>
                        </>}
                        <Select aria-label="平台" value={row.platform || ""} onChange={(event) => updateRow(index, "platform", event.target.value)}>
                          <option value="" disabled hidden>请选择平台</option>{platformOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </Select>
                        {dialog === "outbound" && <>
                          <Input aria-label="订单编号" placeholder="订单编号" value={row.orderId || ""} onChange={(event) => updateRow(index, "orderId", event.target.value)} />
                          <Input aria-label="实收金额" placeholder="实收金额" type="number" min="0" step="0.01" value={row.shopIncome || ""} onChange={(event) => updateRow(index, "shopIncome", event.target.value)} />
                        </>}
                        <Input aria-label="备注" placeholder="备注" value={row.remark || ""} onChange={(event) => updateRow(index, "remark", event.target.value)} />
                        <div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
                          {form.rows.length > 1 && <Button type="button" variant="ghost" size="sm" aria-label="删除此行" onClick={() => removeRow(index)}><X className="h-4 w-4" /></Button>}
                          {index === form.rows.length - 1 && <Button type="button" variant="secondary" size="sm" aria-label="新增一行" onClick={() => addRow({ skuId: "", quantity: 1, platform: row.platform || "", orderId: "", shopIncome: "", remark: "", inboundType: "new", isRepair: false, label: "salable" })}><Plus className="h-4 w-4" /></Button>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Field>
              ) : <Field label="规格名">
                <Select
                  value={String(form.skuId || "")}
                  className={!form.skuId ? "text-slate-400 [&>option]:text-slate-800" : "[&>option]:text-slate-800"}
                  onChange={(event) => onChange("skuId", event.target.value ? Number(event.target.value) : "")}
                  required
                >
                  <option value="">请选择规格</option>
                  {skuOptions.map((sku) => <option key={sku.id} value={sku.id}>{sku.name}</option>)}
                </Select>
              </Field>}
              {dialog === "abnormal" && <Field label="数量">
                <div className="space-y-1">
                  <Input type="number" min={dialog === "abnormal" ? undefined : "1"} step="1" value={form.quantity || 1} onChange={(event) => onChange("quantity", event.target.value)} required />
                  {currentStock !== null && (
                    <p className="text-xs font-medium text-red-600">
                      当前库存数：{currentStock.salableQty}
                    </p>
                  )}
                </div>
              </Field>}
              {dialog === "abnormal" ? (
                <>
                  {Number(form.quantity) < 0 && (
                    <Field label="">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={Boolean(form.addToUnsalable)}
                          onChange={(event) => onChange("addToUnsalable", event.target.checked)}
                        />
                        加入不可售
                      </label>
                    </Field>
                  )}
                  <Field label="原因"><Input value={form.reason || ""} onChange={(event) => onChange("reason", event.target.value)} required /></Field>
                </>
              ) : (
                <Field label="备注"><Input value={form.remark || ""} onChange={(event) => onChange("remark", event.target.value)} /></Field>
              )}
            </>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button className="flex-1 sm:flex-none" variant="secondary" onClick={onClose}>取消</Button>
          <Button className="flex-1 sm:flex-none" type="submit">确定</Button>
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

function AbnormalQuantityText({ log }: { log: InventoryAbnormalLog }) {
  return (
    <>
      {formatSigned(log.quantity)}
      {Number(log.stockLabel) === 2 && <span className="ml-1 font-normal text-slate-500">（不可售）</span>}
    </>
  );
}

function platformLabel(value?: string) {
  if (value === "douyin") return "抖音";
  if (value === "pinduoduo") return "拼多多";
  if (value === "kuaishou") return "快手";
  if (value === "xianyu") return "闲鱼";
  if (value === "wechat") return "微信";
  if (value === "video_account") return "视频号";
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
