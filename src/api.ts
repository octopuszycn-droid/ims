import type {
  Brand,
  InventoryCheckDifference,
  InventoryCheckRecord,
  InventoryLog,
  InventoryLogFilters,
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

type RequestOptions = RequestInit & {
  token?: string;
};

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(data.message || "请求失败", response.status);
  return data as T;
}

async function requestBlob(url: string, options: RequestOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    throw new ApiError(data.message || "请求失败", response.status);
  }
  return response.blob();
}

export const api = {
  login(username: string, password: string) {
    return request<Session>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },
  me(token: string) {
    return request<{ user: User; permissions: PermissionCode[] }>("/api/me", { token });
  },
  users(token: string) {
    return request<User[]>("/api/users", { token });
  },
  createUser(token: string, payload: Record<string, unknown>) {
    return request<{ id: number }>("/api/users", { method: "POST", token, body: JSON.stringify(payload) });
  },
  updateUser(token: string, id: number, payload: Record<string, unknown>) {
    return request("/api/users/" + id, { method: "PUT", token, body: JSON.stringify(payload) });
  },
  deleteUser(token: string, id: number) {
    return request("/api/users/" + id, { method: "DELETE", token });
  },
  brands(token: string, includeHidden = true) {
    return request<Brand[]>(includeHidden ? "/api/brands?includeHidden=1" : "/api/brands", { token });
  },
  createBrand(token: string, payload: Record<string, unknown>) {
    return request("/api/brands", { method: "POST", token, body: JSON.stringify(payload) });
  },
  updateBrand(token: string, id: number, payload: Record<string, unknown>) {
    return request("/api/brands/" + id, { method: "PUT", token, body: JSON.stringify(payload) });
  },
  sortBrands(token: string, ids: number[]) {
    return request("/api/brands/sort", { method: "PATCH", token, body: JSON.stringify({ ids }) });
  },
  setBrandHidden(token: string, id: number, isHidden: boolean) {
    return request("/api/brands/" + id + "/hidden", { method: "PATCH", token, body: JSON.stringify({ isHidden }) });
  },
  products(token: string, brandId?: number, includeHidden = false) {
    const params = new URLSearchParams();
    if (brandId) params.set("brandId", String(brandId));
    if (includeHidden) params.set("includeHidden", "1");
    return request<Product[]>(params.size ? `/api/products?${params.toString()}` : "/api/products", { token });
  },
  createProduct(token: string, payload: Record<string, unknown>) {
    return request("/api/products", { method: "POST", token, body: JSON.stringify(payload) });
  },
  updateProduct(token: string, id: number, payload: Record<string, unknown>) {
    return request("/api/products/" + id, { method: "PUT", token, body: JSON.stringify(payload) });
  },
  sortProducts(token: string, ids: number[]) {
    return request("/api/products/sort", { method: "PATCH", token, body: JSON.stringify({ ids }) });
  },
  setProductHidden(token: string, id: number, isHidden: boolean) {
    return request("/api/products/" + id + "/hidden", { method: "PATCH", token, body: JSON.stringify({ isHidden }) });
  },
  skus(token: string, productId?: number, includeHidden = false, brandId?: number) {
    const params = new URLSearchParams();
    if (productId) params.set("productId", String(productId));
    if (brandId) params.set("brandId", String(brandId));
    if (includeHidden) params.set("includeHidden", "1");
    return request<Sku[]>(params.size ? `/api/skus?${params.toString()}` : "/api/skus", { token });
  },
  createSku(token: string, payload: Record<string, unknown>) {
    return request("/api/skus", { method: "POST", token, body: JSON.stringify(payload) });
  },
  updateSku(token: string, id: number, payload: Record<string, unknown>) {
    return request("/api/skus/" + id, { method: "PUT", token, body: JSON.stringify(payload) });
  },
  sortSkus(token: string, ids: number[]) {
    return request("/api/skus/sort", { method: "PATCH", token, body: JSON.stringify({ ids }) });
  },
  setSkuHidden(token: string, id: number, isHidden: boolean) {
    return request("/api/skus/" + id + "/hidden", { method: "PATCH", token, body: JSON.stringify({ isHidden }) });
  },
  productInventory(token: string) {
    return request<ProductInventoryRow[]>("/api/inventory/products", { token });
  },
  skuInventory(token: string) {
    return request<SkuInventoryRow[]>("/api/inventory/skus", { token });
  },
  skuInventoryItem(token: string, skuId: number) {
    return request<{ skuId: number; salableQty: number; unsalableQty: number; totalQty: number }>("/api/inventory/skus/" + skuId, { token });
  },
  adjustUnsalable(token: string, skuId: number, payload: Record<string, unknown>) {
    return request<{ skuId: number; salableQty: number; unsalableQty: number; totalQty: number }>("/api/inventory/skus/" + skuId + "/unsalable", { method: "PATCH", token, body: JSON.stringify(payload) });
  },
  logs(token: string, page = 1, size = 50, filters: Partial<InventoryLogFilters> = {}) {
    const params = new URLSearchParams({
      limit: String(size),
      offset: String((Math.max(1, page) - 1) * size),
    });
    if (filters.startAt) params.set("startAt", filters.startAt);
    if (filters.endAt) params.set("endAt", filters.endAt);
    if (filters.operationType) params.set("operationType", filters.operationType);
    if (filters.brandId) params.set("brandId", String(filters.brandId));
    if (filters.productId) params.set("productId", String(filters.productId));
    if (filters.inboundType) params.set("inboundType", filters.inboundType);
    if (filters.stockLabel) params.set("stockLabel", filters.stockLabel);
    if (filters.platform) params.set("platform", filters.platform);
    return request<{ rows: InventoryLog[]; total: number }>(`/api/inventory/logs?${params.toString()}`, { token });
  },
  inbound(token: string, payload: Record<string, unknown>) {
    return request("/api/inventory/inbound", { method: "POST", token, body: JSON.stringify(payload) });
  },
  outbound(token: string, payload: Record<string, unknown>) {
    return request("/api/inventory/outbound", { method: "POST", token, body: JSON.stringify(payload) });
  },
  exportExcel(token: string) {
    return requestBlob("/api/excel/export", { token });
  },
  exportInventoryDetail(token: string) {
    return requestBlob("/api/excel/export/inventory-detail", { token });
  },
  exportInventoryLogs(token: string, filters: Partial<InventoryLogFilters> = {}) {
    const params = new URLSearchParams();
    if (filters.startAt) params.set("startAt", filters.startAt);
    if (filters.endAt) params.set("endAt", filters.endAt);
    if (filters.operationType) params.set("operationType", filters.operationType);
    if (filters.brandId) params.set("brandId", String(filters.brandId));
    if (filters.productId) params.set("productId", String(filters.productId));
    if (filters.inboundType) params.set("inboundType", filters.inboundType);
    if (filters.stockLabel) params.set("stockLabel", filters.stockLabel);
    if (filters.platform) params.set("platform", filters.platform);
    return requestBlob(`/api/excel/export/inventory-logs${params.size ? `?${params.toString()}` : ""}`, { token });
  },
  inventoryChecks(token: string) {
    return request<InventoryCheckRecord[]>("/api/inventory/checks", { token });
  },
  inventoryCheckDetail(token: string, id: number) {
    return request<{ record: InventoryCheckRecord; rows: InventoryCheckDifference[] }>(`/api/inventory/checks/${id}`, { token });
  },
  inventoryCheckTemplate(token: string) {
    return requestBlob("/api/inventory/checks/template", { token });
  },
  inventoryCheckFile(token: string, id: number) {
    return requestBlob(`/api/inventory/checks/${id}/file`, { token });
  },
  uploadInventoryCheck(token: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return request<{ record: InventoryCheckRecord; rows: InventoryCheckDifference[] }>("/api/inventory/checks/upload", { method: "POST", token, body: formData });
  },
  importExcel(token: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return request<{ sql: string }>("/api/excel/import", { method: "POST", token, body: formData });
  },
  brandProductSales(token: string, brandId: number, days: number) {
    return request<ProductSalesBreakdown[]>(`/api/stats/sales/brand-products?brandId=${brandId}&days=${days}`, { token });
  },
  productSalesTop(token: string, days: number) {
    return request<ProductSalesTop[]>(`/api/stats/sales/product-top?days=${days}`, { token });
  },
  salesTrend(token: string, period: string, brandIds: number[]) {
    const params = new URLSearchParams({ period });
    if (brandIds.length) params.set("brandIds", brandIds.join(","));
    return request<SalesTrend>(`/api/stats/sales/trend?${params.toString()}`, { token });
  },
  salesAmount(token: string, startDate: string, endDate: string) {
    const params = new URLSearchParams({ startDate, endDate });
    return request<SalesAmountRow[]>(`/api/stats/sales/amount?${params.toString()}`, { token });
  },
};
