export type PermissionCode = "SUPER" | "INVENTORY" | "FINANCE";

export type User = {
  id: number;
  username: string;
  email: string;
  name: string;
  status: number;
  permissions: PermissionCode[];
  subscribedBrandIds: number[];
};

export type Session = {
  token: string;
  expiresAt: string;
  user: User;
  permissions: PermissionCode[];
};

export type PlatformValue = "douyin" | "pinduoduo" | "kuaishou" | "";

export type Brand = {
  id: number;
  name: string;
  remark: string;
  defaultPlatform: PlatformValue;
  sortOrder: number;
  isHidden: 0 | 1;
};

export type Product = {
  id: number;
  brandId: number;
  brandName: string;
  name: string;
  remark: string;
  sortOrder: number;
  isHidden: 0 | 1;
};

export type Sku = {
  id: number;
  productId: number;
  productName: string;
  brandId: number;
  brandName: string;
  name: string;
  purchasePrice: number;
  remark: string;
  sortOrder: number;
  isHidden: 0 | 1;
};

export type SkuInventoryRow = {
  brandId: number;
  brandName: string;
  brandSort: number;
  productId: number;
  productName: string;
  productSort: number;
  skuId: number;
  skuName: string;
  purchasePrice: number;
  skuRemark: string;
  skuSort: number;
  salableQty: number;
  unsalableQty: number;
};

export type ProductInventoryRow = {
  brandId: number;
  brandName: string;
  brandSort: number;
  productId: number;
  productName: string;
  productSort: number;
  totalQty: number;
  salableQty: number;
  unsalableQty: number;
};

export type InventoryLog = {
  id: number;
  operationType: 1 | 2;
  inboundType: 1 | 2 | null;
  stockLabel: 1 | 2;
  quantity: number;
  simultaneousInbound: 0 | 1;
  platform: PlatformValue;
  remark: string;
  createdAt: string;
  operatorName: string;
  brandName: string;
  productName: string;
  skuName: string;
  canRevoke: 0 | 1 | boolean;
  orderId?: string | null;
  shopName?: string | null;
  shopIncome?: number | null;
  isBug?: 0 | 1 | boolean;
  sourceProductText?: string | null;
  brandId?: number | null;
  productId?: number | null;
};

export type InventoryLogFilters = {
  startAt: string;
  endAt: string;
  operationType: "" | "1" | "2";
  brandId: number | "";
  productId: number | "";
  inboundType: "" | "1" | "2";
  stockLabel: "" | "1" | "2";
  platform: PlatformValue;
};

export type InventoryAbnormalLog = {
  id: number;
  quantity: number;
  stockLabel: 1 | 2;
  reason: string;
  createdAt: string;
  operatorName: string;
  brandName: string;
  productName: string;
  skuName: string;
};

export type InventoryCheckRecord = {
  id: number;
  checkTime: string;
  operatorName: string;
  uploadFilePath: string;
  isSynced: 0 | 1 | boolean;
  syncedAt: string | null;
  canSync: 0 | 1 | boolean;
  differenceCount: number;
};

export type InventoryCheckDifference = {
  id: number;
  checkId: number;
  skuId: number;
  brandName: string;
  productName: string;
  skuName: string;
  systemSalableQty: number;
  systemUnsalableQty: number;
  actualSalableQty: number;
  actualUnsalableQty: number;
  salableDiffQty: number;
  salableDiffAmount: number;
  unsalableDiffQty: number;
  unsalableDiffAmount: number;
  purchasePrice: number;
};

export type ProductSalesBreakdown = {
  productId: number;
  productName: string;
  totalQty: number;
  skus: Array<{ skuId: number; skuName: string; quantity: number }>;
};

export type ProductSalesTop = {
  productId: number;
  brandName: string;
  productName: string;
  quantity: number;
};

export type SalesTrend = {
  labels: string[];
  values: number[];
};

export type SalesAmountRow = {
  brandId: number;
  brandName: string;
  productId: number;
  productName: string;
  skuId: number;
  skuName: string;
  purchasePrice: number;
  salesQty: number;
  costAmount: number;
  brandPlatformAmounts?: {
    douyin: number;
    pinduoduo: number;
    kuaishou: number;
    none: number;
  };
};
