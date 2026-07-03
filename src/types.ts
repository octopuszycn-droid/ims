export type PermissionCode = "SUPER" | "INVENTORY" | "FINANCE";

export type User = {
  id: number;
  username: string;
  name: string;
  status: number;
  permissions: PermissionCode[];
};

export type Session = {
  token: string;
  expiresAt: string;
  user: User;
  permissions: PermissionCode[];
};

export type Brand = {
  id: number;
  name: string;
  remark: string;
  defaultPlatform: "douyin" | "pinduoduo" | "";
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
  platform: "douyin" | "pinduoduo" | "";
  remark: string;
  createdAt: string;
  operatorName: string;
  brandName: string;
  productName: string;
  skuName: string;
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
};
