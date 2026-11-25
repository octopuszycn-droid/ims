import bcrypt from "bcryptjs";
import cors from "cors";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 3001);
const jwtSecret = process.env.JWT_SECRET || "change-this-secret-before-production";
const tokenTtlSeconds = 7 * 24 * 60 * 60;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..");
const inventoryCheckUploadDir = path.join(projectRoot, "uploads", "inventory-checks");

const permissionCodeByName = { SUPER: 1, INVENTORY: 2, FINANCE: 3 };
const permissionNameByCode = { 1: "SUPER", 2: "INVENTORY", 3: "FINANCE" };

app.use(cors({ origin(origin, callback) {
  const allowed = process.env.CORS_ORIGIN || "http://127.0.0.1:5173";
  callback(null, !origin || origin === allowed || /^chrome-extension:\/\/[a-z]{32}$/.test(origin));
} }));
app.use(express.json({ limit: "1mb" }));

await ensureSchema();

async function ensureSchema() {
  await query("alter table users modify column email varchar(128) null comment 'optional notification email'");
  await query("alter table brands add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table brands add column if not exists default_platform tinyint unsigned null comment '默认平台：1抖音，2拼多多，3快手，为空表示未选择' after remark");
  await query("alter table products add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table skus add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table inventory_operation_logs add column if not exists platform tinyint unsigned null comment '平台：1抖音，2拼多多，3快手，为空表示未选择' after stock_label");
  await query("alter table inventory_operation_logs modify column sku_id bigint unsigned null comment 'SKU ID；打单匹配失败时为空'");
  await query("alter table inventory_operation_logs add column if not exists order_id varchar(64) null comment '订单编号'");
  await query("alter table inventory_operation_logs add column if not exists shop_name varchar(128) null comment '店铺名'");
  await query("alter table inventory_operation_logs add column if not exists shop_income decimal(12,2) null comment '实收金额'");
  await query("alter table inventory_operation_logs add column if not exists is_bug tinyint unsigned not null default 0 comment '商品匹配异常标记'");
  await query("alter table inventory_operation_logs add column if not exists source_product_text varchar(1000) null comment '打单商品原始文本'");
  await query("alter table inventory_operation_logs add column if not exists matched_brand_id bigint unsigned null comment '打单匹配到的品牌ID'");
  await query("alter table inventory_operation_logs add column if not exists matched_product_id bigint unsigned null comment '打单匹配到的商品ID'");
  await query(`create table if not exists inventory_checks (
    id bigint unsigned not null auto_increment comment '盘点记录ID',
    check_time datetime not null default current_timestamp comment '盘点时间',
    operator_user_id bigint unsigned not null comment '盘点上传人用户ID',
    upload_file_path varchar(255) not null default '' comment '盘点上传原始文件相对路径',
    created_at datetime not null default current_timestamp comment '创建时间',
    primary key (id),
    key idx_inventory_checks_time (check_time, id),
    key idx_inventory_checks_operator (operator_user_id),
    constraint fk_inventory_checks_operator foreign key (operator_user_id) references users (id)
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存盘点记录表'`);
  await query("alter table inventory_checks add column if not exists upload_file_path varchar(255) not null default '' comment '盘点上传原始文件相对路径' after operator_user_id");
  await query("alter table inventory_checks add column if not exists is_synced tinyint unsigned not null default 0 comment 'whether differences have been synced' after upload_file_path");
  await query("alter table inventory_checks add column if not exists synced_at datetime null comment 'difference sync time' after is_synced");
  await query(`create table if not exists inventory_check_differences (
    id bigint unsigned not null auto_increment comment '盘点差异明细ID',
    check_id bigint unsigned not null comment '盘点记录ID',
    sku_id bigint unsigned not null comment 'SKU ID',
    brand_name varchar(64) not null comment '盘点时品牌名快照',
    product_name varchar(64) not null comment '盘点时商品名快照',
    sku_name varchar(64) not null comment '盘点时规格名快照',
    system_salable_qty int not null comment '系统可售库存数',
    system_unsalable_qty int not null comment '系统不可售库存数',
    actual_salable_qty int not null comment '实际可售库存数',
    actual_unsalable_qty int not null comment '实际不可售库存数',
    salable_diff_qty int not null comment '可售库存数差值：实际-系统',
    unsalable_diff_qty int not null comment '不可售库存数差值：实际-系统',
    created_at datetime not null default current_timestamp comment '创建时间',
    primary key (id),
    key idx_inventory_check_diff_check (check_id, id),
    key idx_inventory_check_diff_sku (sku_id),
    constraint fk_inventory_check_diff_check foreign key (check_id) references inventory_checks (id) on delete cascade,
    constraint fk_inventory_check_diff_sku foreign key (sku_id) references skus (id)
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存盘点差异明细表'`);
  await query("alter table inventory_check_differences add column if not exists purchase_price_snapshot decimal(10,2) not null default 0.00 comment '盘点时SKU购入价格快照' after unsalable_diff_qty");
  await query(`create table if not exists inventory_abnormal_logs (
    id bigint unsigned not null auto_increment comment '异常库存记录ID',
    sku_id bigint unsigned not null comment 'SKU ID',
    quantity int not null comment '异常调整数量，正数增加可售库存，负数减少可售库存',
    reason varchar(255) not null comment '异常原因',
    operator_user_id bigint unsigned not null comment '操作人用户ID',
    created_at datetime not null default current_timestamp comment '创建时间',
    primary key (id),
    key idx_inventory_abnormal_time (created_at, id),
    key idx_inventory_abnormal_sku_time (sku_id, created_at),
    key idx_inventory_abnormal_operator_time (operator_user_id, created_at),
    constraint fk_inventory_abnormal_sku foreign key (sku_id) references skus (id),
    constraint fk_inventory_abnormal_operator foreign key (operator_user_id) references users (id),
    constraint chk_inventory_abnormal_quantity check (quantity <> 0)
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='异常库存操作记录表'`);
  await query("alter table inventory_abnormal_logs add column if not exists stock_label tinyint unsigned not null default 1 comment 'stock label: 1 salable, 2 unsalable' after sku_id");
  try {
    await query("alter table sku_inventory drop constraint chk_sku_inventory_qty");
  } catch (error) {
    if (!["ER_CANT_DROP_FIELD_OR_KEY", "ER_CHECK_CONSTRAINT_NOT_FOUND"].includes(error.code)) throw error;
  }
  await query("alter table sku_inventory modify column salable_qty int not null default 0 comment '可售库存数'");
  await query("alter table sku_inventory modify column unsalable_qty int not null default 0 comment '不可售库存数'");
  await query(`create table if not exists scheduled_email_jobs (
    job_key varchar(80) not null comment 'unique scheduled job key',
    job_type varchar(64) not null comment 'scheduled job type',
    status tinyint unsigned not null comment '1 running, 2 sent, 3 failed',
    run_at datetime not null comment 'scheduled run time',
    sent_at datetime null comment 'sent time',
    recipients text null comment 'email recipients',
    message varchar(500) not null default '' comment 'last message',
    created_at datetime not null default current_timestamp comment 'created time',
    updated_at datetime not null default current_timestamp on update current_timestamp comment 'updated time',
    primary key (job_key),
    key idx_scheduled_email_jobs_type_status (job_type, status, run_at)
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='scheduled email job log'`);
  await query(`create table if not exists user_brand_subscriptions (
    user_id bigint unsigned not null comment 'subscriber user id',
    brand_id bigint unsigned not null comment 'subscribed brand id',
    created_at datetime not null default current_timestamp comment 'created time',
    primary key (user_id, brand_id),
    key idx_user_brand_subscriptions_brand (brand_id),
    constraint fk_user_brand_subscriptions_user foreign key (user_id) references users (id) on delete cascade,
    constraint fk_user_brand_subscriptions_brand foreign key (brand_id) references brands (id) on delete cascade
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='user subscribed brands'`);
  await query("alter table brands modify column default_platform tinyint unsigned null comment 'default platform: 1 douyin, 2 pinduoduo, 3 kuaishou, null none'");
  await query("alter table inventory_operation_logs modify column platform tinyint unsigned null comment 'platform: 1 douyin, 2 pinduoduo, 3 kuaishou, null none'");
  try {
    await query("alter table inventory_operation_logs drop constraint chk_inventory_logs_platform");
  } catch (error) {
    if (!["ER_CANT_DROP_FIELD_OR_KEY", "ER_CHECK_CONSTRAINT_NOT_FOUND"].includes(error.code)) throw error;
  }
  try {
    await query("alter table inventory_operation_logs add constraint chk_inventory_logs_platform check (platform is null or platform in (1, 2, 3))");
  } catch (error) {
    if (error.code !== "ER_DUP_CHECK_CONSTRAINT_NAME") throw error;
  }
  await backfillPddOrderMatches();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function assertName(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw badRequest(`${label}不能为空`);
  if (Array.from(normalized).length > 15) throw badRequest(`${label}不能超过15个汉字`);
  return normalized;
}

function assertUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(username)) {
    throw badRequest("英文用户名需以字母开头，支持字母、数字、下划线，长度3-32位");
  }
  return username;
}

function assertPassword(password) {
  if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d\S]{6,}$/.test(String(password || ""))) {
    throw badRequest("密码至少6位，且必须包含数字和字母");
  }
}

function normalizeOptionalEmail(value) {
  const email = String(value || "").trim();
  if (!email) return null;
  if (email.length > 128 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("邮箱格式不正确");
  return email;
}

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) throw badRequest("至少绑定一个权限");
  const codes = [...new Set(permissions.map((item) => permissionCodeByName[item]).filter(Boolean))];
  if (codes.length !== new Set(permissions).size) throw badRequest("权限参数不合法");
  return codes;
}

function normalizePlatform(value) {
  if (value === "douyin") return 1;
  if (value === "pinduoduo") return 2;
  if (value === "kuaishou") return 3;
  return null;
}

async function getUserPermissions(userId) {
  const rows = await query("select permission_code from user_permissions where user_id = ?", [userId]);
  return rows.map((row) => permissionNameByCode[row.permission_code]).filter(Boolean);
}

async function findUserById(userId) {
  const rows = await query(
    "select id, username, email, name, status, created_at, updated_at from users where id = ? and deleted_at is null",
    [userId],
  );
  return rows[0] || null;
}

function signToken(user, permissions) {
  const expiresAt = new Date(Date.now() + tokenTtlSeconds * 1000).toISOString();
  const token = jwt.sign({ userId: user.id, permissions }, jwtSecret, { expiresIn: tokenTtlSeconds });
  return { token, expiresAt };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ message: "请先登录" });

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch {
    return res.status(401).json({ message: "登录已过期，请重新登录" });
  }

  try {
    const user = await findUserById(payload.userId);
    if (!user || user.status !== 1) return res.status(401).json({ message: "用户不存在或已停用" });
    req.user = { ...user, permissions: await getUserPermissions(user.id) };
    next();
  } catch (error) {
    next(error);
  }
}

function requireAnyPermission(allowed) {
  return (req, res, next) => {
    if (req.user.permissions.includes("SUPER") || allowed.some((item) => req.user.permissions.includes(item))) {
      next();
      return;
    }
    res.status(403).json({ message: "当前账号没有操作权限" });
  };
}

function requireSuper(req, res, next) {
  if (req.user.permissions.includes("SUPER")) return next();
  res.status(403).json({ message: "仅超级权限可操作" });
}

function readScope(req, res, next) {
  if (req.user.permissions.length > 0) return next();
  res.status(403).json({ message: "当前账号没有查看权限" });
}

function toNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`${label}不合法`);
  return number;
}

function toPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw badRequest(`${label}必须是正整数`);
  return number;
}

function toNonZeroInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number === 0) throw badRequest(`${label}必须是非0整数`);
  return number;
}

function normalizePageLimit(value) {
  const number = Number(value || 50);
  if (!Number.isInteger(number) || number <= 0) return 50;
  return Math.min(number, 200);
}

function normalizeOffset(value) {
  const number = Number(value || 0);
  if (!Number.isInteger(number) || number < 0) return 0;
  return number;
}

function normalizeDateTimeFilter(value, label, boundary = "start") {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(normalized)) {
    throw badRequest(`${label}不合法`);
  }
  if (normalized.length === 10) return `${normalized} ${boundary === "end" ? "23:59:59" : "00:00:00"}`;
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

async function listCatalog(options = {}) {
  const filters = ["b.deleted_at is null"];
  const params = [];
  if (options.excludeSupplementBrands) {
    filters.push("b.name <> ?");
    params.push("流水补录");
  }
  return query(
    `select b.id as brandId, b.name as brandName, b.sort_order as brandSort,
       p.id as productId, p.name as productName, p.sort_order as productSort,
       s.id as skuId, s.name as skuName, s.purchase_price as purchasePrice,
       s.remark as skuRemark, s.sort_order as skuSort,
       coalesce(i.salable_qty, 0) as salableQty, coalesce(i.unsalable_qty, 0) as unsalableQty
     from brands b
     join products p on p.brand_id = b.id and p.deleted_at is null
     join skus s on s.product_id = p.id and s.deleted_at is null
     left join sku_inventory i on i.sku_id = s.id
     where ${filters.join(" and ")}
     order by b.is_hidden, b.sort_order, b.id, p.is_hidden, p.sort_order, p.id, s.is_hidden, s.sort_order, s.id`,
    params,
  );
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const username = assertUsername(req.body.username);
    const password = String(req.body.password || "");
    const rows = await query(
      "select id, username, email, name, password_hash, status from users where username = ? and deleted_at is null",
      [username],
    );
    const user = rows[0];
    if (!user || user.status !== 1) return res.status(401).json({ message: "用户名或密码错误" });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "用户名或密码错误" });
    }
    const permissions = await getUserPermissions(user.id);
    res.json({ user: { id: user.id, username: user.username, email: user.email || "", name: user.name, status: user.status, permissions }, permissions, ...signToken(user, permissions) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireAuth, (_req, res) => res.json({ ok: true }));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user, permissions: req.user.permissions }));

app.get("/api/users", requireAuth, requireSuper, async (_req, res, next) => {
  try {
    const rows = await query(
      `select u.id, u.username, u.email, u.name, u.status, u.created_at as createdAt,
        group_concat(distinct up.permission_code order by up.permission_code) as permissionCodes,
        group_concat(distinct ubs.brand_id order by ubs.brand_id) as subscribedBrandIds
       from users u
       left join user_permissions up on up.user_id = u.id
       left join user_brand_subscriptions ubs on ubs.user_id = u.id
       where u.deleted_at is null
       group by u.id, u.username, u.email, u.name, u.status, u.created_at
       order by u.id`,
    );
    res.json(rows.map((row) => ({
      ...row,
      email: row.email || "",
      permissions: String(row.permissionCodes || "").split(",").filter(Boolean).map((code) => permissionNameByCode[code]),
      subscribedBrandIds: String(row.subscribedBrandIds || "").split(",").filter(Boolean).map(Number),
    })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const username = assertUsername(req.body.username);
    const name = assertName(req.body.name, "真实姓名");
    const email = normalizeOptionalEmail(req.body.email);
    const password = String(req.body.password || "");
    assertPassword(password);
    const permissionCodes = normalizePermissions(req.body.permissions);
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = await withTransaction(async (connection) => {
      const [created] = await connection.execute(
        "insert into users(username, email, name, password_hash, status) values(?, ?, ?, ?, 1)",
        [username, email, name, passwordHash],
      );
      for (const code of permissionCodes) {
        await connection.execute("insert into user_permissions(user_id, permission_code) values(?, ?)", [created.insertId, code]);
      }
      return created.insertId;
    });
    res.status(201).json({ id: userId });
  } catch (error) {
    next(error);
  }
});

app.put("/api/users/:id", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const username = assertUsername(req.body.username);
    const name = assertName(req.body.name, "真实姓名");
    const email = normalizeOptionalEmail(req.body.email);
    const status = req.body.status === 0 ? 0 : 1;
    const permissionCodes = normalizePermissions(req.body.permissions);
    const password = String(req.body.password || "");
    if (password) assertPassword(password);
    await withTransaction(async (connection) => {
      if (password) {
        await connection.execute(
          "update users set username = ?, email = ?, name = ?, password_hash = ?, status = ? where id = ?",
          [username, email, name, await bcrypt.hash(password, 10), status, userId],
        );
      } else {
        await connection.execute("update users set username = ?, email = ?, name = ?, status = ? where id = ?", [
          username,
          email,
          name,
          status,
          userId,
        ]);
      }
      await connection.execute("delete from user_permissions where user_id = ?", [userId]);
      for (const code of permissionCodes) {
        await connection.execute("insert into user_permissions(user_id, permission_code) values(?, ?)", [userId, code]);
      }
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/:id/brand-subscriptions", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const targetUser = await findUserById(userId);
    if (!targetUser) throw badRequest("用户不存在");
    const targetPermissions = await getUserPermissions(userId);
    if (!targetPermissions.includes("SUPER")) throw badRequest("只有超级管理员用户可以订阅品牌");
    const brandIds = [...new Set((Array.isArray(req.body.brandIds) ? req.body.brandIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (brandIds.length) {
      const rows = await query(
        `select id from brands where deleted_at is null and id in (${brandIds.map(() => "?").join(",")})`,
        brandIds,
      );
      if (rows.length !== brandIds.length) throw badRequest("订阅品牌参数不合法");
    }
    await withTransaction(async (connection) => {
      await connection.execute("delete from user_brand_subscriptions where user_id = ?", [userId]);
      for (const brandId of brandIds) {
        await connection.execute("insert into user_brand_subscriptions(user_id, brand_id) values(?, ?)", [userId, brandId]);
      }
    });
    res.json({ ok: true, subscribedBrandIds: brandIds });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/users/:id", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (userId === req.user.id) throw badRequest("不能删除当前登录用户");
    await query("update users set deleted_at = now() where id = ?", [userId]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/brands", requireAuth, readScope, async (req, res, next) => {
  try {
    const includeHidden = req.query.includeHidden === "1";
    res.json(
      await query(
        `select id, name, remark,
          case default_platform when 1 then 'douyin' when 2 then 'pinduoduo' when 3 then 'kuaishou' else '' end as defaultPlatform,
          sort_order as sortOrder, is_hidden as isHidden
         from brands
         where deleted_at is null and (? = 1 or is_hidden = 0)
         order by is_hidden, sort_order, id`,
        [includeHidden ? 1 : 0],
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.post("/api/brands", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from brands");
    const result = await query("insert into brands(name, remark, default_platform, sort_order) values(?, ?, ?, ?)", [
      assertName(req.body.name, "品牌名"),
      String(req.body.remark || "").trim(),
      normalizePlatform(req.body.defaultPlatform),
      maxSort,
    ]);
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    next(error);
  }
});

app.put("/api/brands/:id", requireAuth, requireSuper, async (req, res, next) => {
  try {
    await query("update brands set name = ?, remark = ?, default_platform = ? where id = ?", [
      assertName(req.body.name, "品牌名"),
      String(req.body.remark || "").trim(),
      normalizePlatform(req.body.defaultPlatform),
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/brands/sort", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    await withTransaction(async (connection) => {
      for (const [index, id] of ids.entries()) await connection.execute("update brands set sort_order = ? where id = ?", [(index + 1) * 10, id]);
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/brands/:id/hidden", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const isHidden = req.body.isHidden ? 1 : 0;
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from brands where deleted_at is null");
    await query("update brands set is_hidden = ?, sort_order = ? where id = ?", [isHidden, maxSort, id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/products", requireAuth, readScope, async (req, res, next) => {
  try {
    const brandId = Number(req.query.brandId || 0);
    const includeHidden = req.query.includeHidden === "1";
    res.json(
      await query(
        `select p.id, p.brand_id as brandId, b.name as brandName, p.name, p.remark, p.sort_order as sortOrder, p.is_hidden as isHidden
         from products p join brands b on b.id = p.brand_id
         where p.deleted_at is null and b.deleted_at is null
           and (? = 0 or p.brand_id = ?)
           and (? = 1 or (p.is_hidden = 0 and b.is_hidden = 0))
         order by b.is_hidden, b.sort_order, b.id, p.is_hidden, p.sort_order, p.id`,
        [brandId, brandId, includeHidden ? 1 : 0],
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.post("/api/products", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const brandId = Number(req.body.brandId);
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from products where brand_id = ?", [brandId]);
    const result = await query("insert into products(brand_id, name, remark, sort_order) values(?, ?, ?, ?)", [
      brandId,
      assertName(req.body.name, "商品名"),
      String(req.body.remark || "").trim(),
      maxSort,
    ]);
    res.status(201).json({ id: result.insertId });
  } catch (error) {
    next(error);
  }
});

app.put("/api/products/:id", requireAuth, requireSuper, async (req, res, next) => {
  try {
    await query("update products set brand_id = ?, name = ?, remark = ? where id = ?", [
      Number(req.body.brandId),
      assertName(req.body.name, "商品名"),
      String(req.body.remark || "").trim(),
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/products/sort", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    await withTransaction(async (connection) => {
      for (const [index, id] of ids.entries()) await connection.execute("update products set sort_order = ? where id = ?", [(index + 1) * 10, id]);
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/products/:id/hidden", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const isHidden = req.body.isHidden ? 1 : 0;
    const rows = await query("select brand_id as brandId from products where id = ?", [id]);
    if (!rows[0]) throw badRequest("商品不存在");
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from products where brand_id = ? and deleted_at is null", [rows[0].brandId]);
    await query("update products set is_hidden = ?, sort_order = ? where id = ?", [isHidden, maxSort, id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/skus", requireAuth, readScope, async (req, res, next) => {
  try {
    const productId = Number(req.query.productId || 0);
    const brandId = Number(req.query.brandId || 0);
    const includeHidden = req.query.includeHidden === "1";
    res.json(
      await query(
        `select s.id, s.product_id as productId, p.name as productName, b.id as brandId, b.name as brandName,
          s.name, s.purchase_price as purchasePrice, s.remark, s.sort_order as sortOrder, s.is_hidden as isHidden
         from skus s
         join products p on p.id = s.product_id
         join brands b on b.id = p.brand_id
         where s.deleted_at is null and p.deleted_at is null and b.deleted_at is null
           and (? = 0 or s.product_id = ?)
           and (? = 0 or b.id = ?)
           and (? = 1 or (s.is_hidden = 0 and p.is_hidden = 0 and b.is_hidden = 0))
         order by b.is_hidden, b.sort_order, b.id, p.is_hidden, p.sort_order, p.id, s.is_hidden, s.sort_order, s.id`,
        [productId, productId, brandId, brandId, includeHidden ? 1 : 0],
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.post("/api/skus", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const productId = Number(req.body.productId);
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from skus where product_id = ?", [productId]);
    const skuId = await withTransaction(async (connection) => {
      const [created] = await connection.execute(
        "insert into skus(product_id, name, purchase_price, remark, sort_order) values(?, ?, ?, ?, ?)",
        [productId, assertName(req.body.name, "规格名"), toNumber(req.body.purchasePrice, "购入价格"), String(req.body.remark || "").trim(), maxSort],
      );
      await connection.execute("insert into sku_inventory(sku_id, salable_qty, unsalable_qty) values(?, 0, 0)", [created.insertId]);
      return created.insertId;
    });
    res.status(201).json({ id: skuId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/skus/batch", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const productId = Number(req.body.productId);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!Number.isInteger(productId) || productId <= 0) throw badRequest("商品不合法");
    if (!rows.length) throw badRequest("请至少填写一行规格信息");
    const created = await withTransaction(async (connection) => {
      const [productRows] = await connection.execute("select id from products where id = ? and deleted_at is null", [productId]);
      if (!productRows[0]) throw badRequest("商品不存在");
      const [sortRows] = await connection.execute("select coalesce(max(sort_order), 0) + 10 as maxSort from skus where product_id = ?", [productId]);
      const ids = [];
      for (const [index, row] of rows.entries()) {
        const [result] = await connection.execute(
          "insert into skus(product_id, name, purchase_price, remark, sort_order) values(?, ?, ?, ?, ?)",
          [productId, assertName(row.name, "规格名"), toNumber(row.purchasePrice, "购入价格"), String(row.remark || "").trim(), Number(sortRows[0].maxSort) + index * 10],
        );
        await connection.execute("insert into sku_inventory(sku_id, salable_qty, unsalable_qty) values(?, 0, 0)", [result.insertId]);
        ids.push(result.insertId);
      }
      return ids;
    });
    res.status(201).json({ ids: created });
  } catch (error) {
    next(error);
  }
});

app.put("/api/skus/:id", requireAuth, requireSuper, async (req, res, next) => {
  try {
    await query("update skus set product_id = ?, name = ?, purchase_price = ?, remark = ? where id = ?", [
      Number(req.body.productId),
      assertName(req.body.name, "规格名"),
      toNumber(req.body.purchasePrice, "购入价格"),
      String(req.body.remark || "").trim(),
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/skus/sort", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    await withTransaction(async (connection) => {
      for (const [index, id] of ids.entries()) await connection.execute("update skus set sort_order = ? where id = ?", [(index + 1) * 10, id]);
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/skus/:id/hidden", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const isHidden = req.body.isHidden ? 1 : 0;
    const rows = await query("select product_id as productId from skus where id = ?", [id]);
    if (!rows[0]) throw badRequest("SKU不存在");
    const [{ maxSort }] = await query("select coalesce(max(sort_order), 0) + 10 as maxSort from skus where product_id = ? and deleted_at is null", [rows[0].productId]);
    await query("update skus set is_hidden = ?, sort_order = ? where id = ?", [isHidden, maxSort, id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/skus", requireAuth, readScope, async (_req, res, next) => {
  try {
    res.json(await listCatalog());
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/skus/:id", requireAuth, readScope, async (req, res, next) => {
  try {
    const rows = await query(
      `select s.id as skuId, coalesce(i.salable_qty, 0) as salableQty, coalesce(i.unsalable_qty, 0) as unsalableQty
       from skus s
       left join sku_inventory i on i.sku_id = s.id
       where s.id = ? and s.deleted_at is null`,
      [Number(req.params.id)],
    );
    if (!rows[0]) throw badRequest("规格不存在");
    const row = rows[0];
    res.json({ ...row, totalQty: Number(row.salableQty) + Number(row.unsalableQty) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/inventory/skus/:id/unsalable", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const skuId = Number(req.params.id);
    const quantity = toPositiveInteger(req.body.quantity, "数量");
    const addToSalable = Boolean(req.body.addToSalable);
    const result = await withTransaction(async (connection) => {
      const [stockRows] = await connection.execute("select salable_qty, unsalable_qty from sku_inventory where sku_id = ? for update", [skuId]);
      const stock = stockRows[0];
      if (!stock) throw badRequest("规格库存不存在");
      const currentUnsalable = Number(stock.unsalable_qty);
      if (quantity > currentUnsalable) throw badRequest("调整数量不能大于不可售库存数");
      const nextUnsalable = currentUnsalable - quantity;
      const nextSalable = Number(stock.salable_qty) + (addToSalable ? quantity : 0);
      await connection.execute("update sku_inventory set salable_qty = ?, unsalable_qty = ? where sku_id = ?", [nextSalable, nextUnsalable, skuId]);
      return { skuId, salableQty: nextSalable, unsalableQty: nextUnsalable, totalQty: nextSalable + nextUnsalable };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/products", requireAuth, readScope, async (_req, res, next) => {
  try {
    const byProduct = new Map();
    for (const row of await listCatalog()) {
      const current = byProduct.get(row.productId) || {
        brandId: row.brandId,
        brandName: row.brandName,
        brandSort: row.brandSort,
        productId: row.productId,
        productName: row.productName,
        productSort: row.productSort,
        totalQty: 0,
        salableQty: 0,
        unsalableQty: 0,
      };
      current.salableQty += Number(row.salableQty);
      current.unsalableQty += Number(row.unsalableQty);
      current.totalQty = current.salableQty + current.unsalableQty;
      byProduct.set(row.productId, current);
    }
    res.json([...byProduct.values()]);
  } catch (error) {
    next(error);
  }
});

async function applyInventoryOperation(connection, req, mode, body) {
  const skuId = Number(body.skuId);
  const quantity = toPositiveInteger(body.quantity, "数量");
  const label = body.label === "unsalable" ? "unsalable" : "salable";
  const labelCode = label === "salable" ? 1 : 2;
  const inboundType = body.inboundType === "new" ? 1 : 2;
  const platform = normalizePlatform(body.platform);
  const simultaneousInbound = Boolean(body.simultaneousInbound);
  const operationType = mode === "in" ? 1 : 2;
  const [stockRows] = await connection.execute("select salable_qty, unsalable_qty from sku_inventory where sku_id = ? for update", [skuId]);
  const stock = stockRows[0];
  if (!stock) throw badRequest("规格库存不存在");
  let salable = Number(stock.salable_qty);
  let unsalable = Number(stock.unsalable_qty);
  if (mode === "in") {
    if (label === "salable") salable += quantity;
    else unsalable += quantity;
  } else if (label === "salable") {
    salable -= quantity;
  } else {
    unsalable -= quantity;
    if (simultaneousInbound) salable += quantity;
  }
  await connection.execute("update sku_inventory set salable_qty = ?, unsalable_qty = ? where sku_id = ?", [salable, unsalable, skuId]);
  const [created] = await connection.execute(
    `insert into inventory_operation_logs
      (sku_id, operation_type, inbound_type, stock_label, platform, quantity, simultaneous_inbound, remark, order_id, shop_name, shop_income, is_bug, source_product_text, operator_user_id)
     values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [skuId, operationType, mode === "in" ? inboundType : null, labelCode, platform, quantity, mode === "out" && label === "unsalable" && simultaneousInbound ? 1 : 0, String(body.remark || "").trim(), body.orderId || null, body.shopName || null, body.shopIncome == null || body.shopIncome === "" ? null : Number(body.shopIncome), body.isBug ? 1 : 0, body.sourceProductText || null, req.user.id],
  );
  return { id: created.insertId, salableQty: salable, unsalableQty: unsalable };
}

async function writeInventoryOperation(req, mode) {
  return withTransaction((connection) => applyInventoryOperation(connection, req, mode, req.body));
}

app.post("/api/inventory/inbound", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    res.status(201).json(await writeInventoryOperation(req, "in"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/outbound", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    res.status(201).json(await writeInventoryOperation(req, "out"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/operations/batch", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const mode = req.body.mode === "in" ? "in" : req.body.mode === "out" ? "out" : null;
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!mode) throw badRequest("操作类型不合法");
    if (!rows.length) throw badRequest("请至少填写一行操作");
    const results = await withTransaction(async (connection) => {
      const applied = [];
      for (const row of rows) applied.push(await applyInventoryOperation(connection, req, mode, row));
      return applied;
    });
    res.status(201).json({ results });
  } catch (error) {
    next(error);
  }
});

function normalizeProductMatch(value) {
  return String(value || "").toLowerCase()
    .replace(/超轻超硬|超轻|轻量|小综合|综合竿|超硬|野钓|黑坑|碳素|鱼竿|钓竿|台钓|鲫鲤|全新正品|防伪可查|假一赔十|不支持下水试用/g, "")
    .replace(/[一二三四五六七八九十]/g, (digit) => ({ 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" })[digit])
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

async function backfillPddOrderMatches() {
  const [logs] = await pool.execute(
    "select id, source_product_text from inventory_operation_logs where is_bug=1 and matched_brand_id is null and source_product_text is not null",
  );
  if (!logs.length) return;
  const [brands] = await pool.execute("select id, name from brands where deleted_at is null order by sort_order, id");
  const orderedBrands = brands.filter((brand) => brand.name && String(brand.name).trim());
  const productsByBrand = new Map();
  for (const log of logs) {
    const text = String(log.source_product_text || "");
    const brand = orderedBrands.find((row) => text.includes(row.name));
    if (!brand) continue;
    if (!productsByBrand.has(brand.id)) {
      const [products] = await pool.execute(
        "select id, name from products where brand_id=? and deleted_at is null order by sort_order,id",
        [brand.id],
      );
      productsByBrand.set(brand.id, products);
    }
    const normalizedText = normalizeProductMatch(text);
    const product = productsByBrand.get(brand.id)
      .map((row) => ({ ...row, matchName: normalizeProductMatch(row.name) }))
      .filter((row) => row.matchName && normalizedText.includes(row.matchName))
      .sort((a, b) => b.matchName.length - a.matchName.length)[0];
    await pool.execute(
      "update inventory_operation_logs set matched_brand_id=?, matched_product_id=? where id=?",
      [brand.id, product?.id || null, log.id],
    );
  }
}

function normalizeSkuMatch(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/米|厘米|cm|mm|m/g, "").replace(/[^\p{L}0-9.]/gu, "");
}

function findMatchingSku(skus, productText) {
  const normalizedText = normalizeSkuMatch(productText);
  const sorted = [...skus].sort((a, b) => normalizeSkuMatch(b.name).length - normalizeSkuMatch(a.name).length);
  return sorted.find((row) => {
    const name = normalizeSkuMatch(row.name);
    if (!name) return false;
    if (/[a-z]/.test(name)) return normalizedText.includes(name);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^0-9.])${escaped}(?=$|[^0-9.])`).test(normalizedText);
  }) || null;
}

app.post("/api/inventory/orders/sync", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const platform = normalizePlatform(req.body.platform);
    const orders = Array.isArray(req.body.orders) ? req.body.orders : [];
    if (!platform) throw badRequest("平台不合法");
    if (!orders.length || orders.length > 500) throw badRequest("订单明细数量不合法");
    const results = await withTransaction(async (connection) => {
      const [brands] = await connection.execute("select id, name from brands where deleted_at is null order by sort_order, id");
      const created = [];
      for (const item of orders) {
        const text = String(item.productText || "").trim();
        const quantity = toPositiveInteger(item.quantity, "数量");
        if (!String(item.orderId || "").trim()) throw badRequest("订单编号不能为空");
        const brand = brands.find((row) => row.name && text.includes(row.name));
        let product = null;
        let sku = null;
        if (brand) {
          const [products] = await connection.execute("select id, name from products where brand_id=? and deleted_at is null order by sort_order,id", [brand.id]);
          const normalizedText = normalizeProductMatch(text);
          product = [...products]
            .map((row) => ({ ...row, matchName: normalizeProductMatch(row.name) }))
            .filter((row) => row.matchName && normalizedText.includes(row.matchName))
            .sort((a, b) => b.matchName.length - a.matchName.length)[0] || null;
          if (product) {
            const [skus] = await connection.execute("select id, name from skus where product_id=? and deleted_at is null order by sort_order,id", [product.id]);
            sku = findMatchingSku(skus, text);
          }
        }
        const orderMeta = {
          orderId: String(item.orderId).slice(0, 64), shopName: String(item.shopName || "").slice(0, 128),
          shopIncome: item.shopIncome, sourceProductText: text,
        };
        if (sku) {
          created.push(await applyInventoryOperation(connection, req, "out", {
            skuId: sku.id, quantity, platform: req.body.platform, label: "salable",
            remark: "拼多多打单同步", ...orderMeta,
          }));
        } else {
          const income = orderMeta.shopIncome == null || orderMeta.shopIncome === "" ? null : Number(orderMeta.shopIncome);
          const [log] = await connection.execute(
            `insert into inventory_operation_logs (sku_id,operation_type,inbound_type,stock_label,platform,quantity,remark,order_id,shop_name,shop_income,is_bug,source_product_text,matched_brand_id,matched_product_id,operator_user_id)
             values(null,2,null,1,?,?,'拼多多打单同步',?,?,?,?,?,?,?,?)`,
            [platform, quantity, orderMeta.orderId, orderMeta.shopName, income, 1, text, brand?.id || null, product?.id || null, req.user.id],
          );
          created.push({ id: log.insertId, isBug: true });
        }
      }
      return created;
    });
    res.status(201).json({ results });
  } catch (error) { next(error); }
});

app.patch("/api/inventory/orders/:id/resolve", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const skuId = Number(req.body.skuId);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(skuId) || skuId <= 0) throw badRequest("订单或规格不合法");
    await withTransaction(async (connection) => {
      const [logs] = await connection.execute("select * from inventory_operation_logs where id=? and is_bug=1 for update", [id]);
      const log = logs[0];
      if (!log) throw badRequest("异常订单不存在或已补全");
      const [stocks] = await connection.execute("select i.salable_qty,p.id as productId,b.id as brandId from sku_inventory i join skus s on s.id=i.sku_id join products p on p.id=s.product_id join brands b on b.id=p.brand_id where i.sku_id=? for update", [skuId]);
      if (!stocks[0]) throw badRequest("规格库存不存在");
      const qty = Number(stocks[0].salable_qty) - Number(log.quantity);
      if (qty < 0) throw badRequest("可售库存不足，无法完成出库");
      await connection.execute("update sku_inventory set salable_qty=? where sku_id=?", [qty, skuId]);
      await connection.execute("update inventory_operation_logs set sku_id=?,matched_brand_id=?,matched_product_id=?,is_bug=0 where id=?", [skuId, stocks[0].brandId, stocks[0].productId, id]);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/inventory/abnormal", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const skuId = Number(req.body.skuId);
    if (!Number.isInteger(skuId) || skuId <= 0) throw badRequest("规格不合法");
    const quantity = toNonZeroInteger(req.body.quantity, "数量");
    const addToUnsalable = quantity < 0 && Boolean(req.body.addToUnsalable);
    const reason = String(req.body.reason || "").trim();
    if (!reason) throw badRequest("原因不能为空");
    if (reason.length > 255) throw badRequest("原因不能超过255个字符");

    const result = await withTransaction(async (connection) => {
      const [stockRows] = await connection.execute("select salable_qty, unsalable_qty from sku_inventory where sku_id = ? for update", [skuId]);
      const stock = stockRows[0];
      if (!stock) throw badRequest("规格库存不存在");
      const salable = Number(stock.salable_qty) + quantity;
      const unsalable = Number(stock.unsalable_qty) + (addToUnsalable ? Math.abs(quantity) : 0);
      await connection.execute("update sku_inventory set salable_qty = ?, unsalable_qty = ? where sku_id = ?", [salable, unsalable, skuId]);
      const [created] = await connection.execute(
        `insert into inventory_abnormal_logs (sku_id, stock_label, quantity, reason, operator_user_id)
         values(?, 1, ?, ?, ?)`,
        [skuId, quantity, reason, req.user.id],
      );
      if (addToUnsalable) {
        await connection.execute(
          `insert into inventory_abnormal_logs (sku_id, stock_label, quantity, reason, operator_user_id)
           values(?, 2, ?, ?, ?)`,
          [skuId, Math.abs(quantity), reason, req.user.id],
        );
      }
      return { id: created.insertId, skuId, quantity, salableQty: salable, unsalableQty: unsalable };
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/inventory/logs/:id", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest("日志ID不合法");
    await withTransaction(async (connection) => {
      const [logRows] = await connection.execute(
        `select id, sku_id as skuId, operation_type as operationType, inbound_type as inboundType,
            stock_label as stockLabel, quantity, simultaneous_inbound as simultaneousInbound,
            timestampdiff(second, created_at, now()) as ageSeconds
         from inventory_operation_logs
         where id = ?
         for update`,
        [id],
      );
      const log = logRows[0];
      if (!log) throw badRequest("库存操作记录不存在");
      if (Number(log.ageSeconds) > 10 * 60) throw badRequest("只能撤销10分钟内的库存操作");

      if (log.skuId) {
        const [stockRows] = await connection.execute("select salable_qty, unsalable_qty from sku_inventory where sku_id = ? for update", [log.skuId]);
        const stock = stockRows[0];
        if (!stock) throw badRequest("规格库存不存在");
        let salable = Number(stock.salable_qty);
        let unsalable = Number(stock.unsalable_qty);
        const quantity = Number(log.quantity);
        const stockLabel = Number(log.stockLabel);
        const operationType = Number(log.operationType);
        const simultaneousInbound = Number(log.simultaneousInbound) === 1;

        if (operationType === 1) {
          if (stockLabel === 1) salable -= quantity;
          else unsalable -= quantity;
        } else if (stockLabel === 1) {
          salable += quantity;
        } else {
          unsalable += quantity;
          if (simultaneousInbound) salable -= quantity;
        }
        await connection.execute("update sku_inventory set salable_qty = ?, unsalable_qty = ? where sku_id = ?", [salable, unsalable, log.skuId]);
      }
      await connection.execute("delete from inventory_operation_logs where id = ?", [id]);
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function normalizeFilterId(value, label) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw badRequest(`${label}不合法`);
  return number;
}

function buildInventoryLogQueryFilters(source) {
  const startAt = normalizeDateTimeFilter(source.startAt, "起始时间", "start");
  const endAt = normalizeDateTimeFilter(source.endAt, "结束时间", "end");
  const operationType = [1, 2].includes(Number(source.operationType)) ? Number(source.operationType) : 0;
  const brandId = normalizeFilterId(source.brandId, "品牌");
  const productId = normalizeFilterId(source.productId, "商品");
  const inboundType = [1, 2].includes(Number(source.inboundType)) ? Number(source.inboundType) : 0;
  const stockLabel = [1, 2].includes(Number(source.stockLabel)) ? Number(source.stockLabel) : 0;
  const platform = normalizePlatform(source.platform);
  const conditions = [];
  const params = [];
  if (startAt) {
    conditions.push("l.created_at >= ?");
    params.push(startAt);
  }
  if (endAt) {
    conditions.push("l.created_at <= ?");
    params.push(endAt);
  }
  if (operationType) {
    conditions.push("l.operation_type = ?");
    params.push(operationType);
  }
  if (brandId) {
    conditions.push("b.id = ?");
    params.push(brandId);
  }
  if (productId) {
    conditions.push("p.id = ?");
    params.push(productId);
  }
  if (inboundType) {
    conditions.push("l.inbound_type = ?");
    params.push(inboundType);
  }
  if (stockLabel) {
    conditions.push("l.stock_label = ?");
    params.push(stockLabel);
  }
  if (platform) {
    conditions.push("l.platform = ?");
    params.push(platform);
  }
  return { whereSql: conditions.length ? ` where ${conditions.join(" and ")}` : "", params };
}

async function queryInventoryLogs(filters, paging = {}) {
  const { whereSql, params } = buildInventoryLogQueryFilters(filters);
  const fromSql = `from inventory_operation_logs l
       join users u on u.id = l.operator_user_id
       left join skus s on s.id = l.sku_id
       left join products p on p.id = coalesce(s.product_id, l.matched_product_id)
       left join brands b on b.id = coalesce(p.brand_id, l.matched_brand_id)
       ${whereSql}`;
  const [totalRow] = await query(`select count(*) as total ${fromSql}`, params);
  const limitSql = paging.limit ? " limit ? offset ?" : "";
  const limitParams = paging.limit ? [paging.limit, paging.offset || 0] : [];
  const rows = await query(
    `select l.id, l.operation_type as operationType, l.inbound_type as inboundType,
        l.stock_label as stockLabel, l.quantity, l.simultaneous_inbound as simultaneousInbound,
        case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' when 3 then 'kuaishou' else '' end as platform,
        l.remark, l.order_id as orderId, l.shop_name as shopName, l.shop_income as shopIncome,
        l.is_bug as isBug, l.source_product_text as sourceProductText,
        date_format(l.created_at, '%Y-%m-%d %H:%i:%s') as createdAt,
        case when l.remark = '拼多多打单同步' then '系统' else u.name end as operatorName,
        b.id as brandId, p.id as productId, coalesce(b.name, '') as brandName, coalesce(p.name, '') as productName, coalesce(s.name, l.source_product_text, '') as skuName,
        timestampdiff(second, l.created_at, now()) <= 600 as canRevoke
       ${fromSql}
       order by l.id desc${limitSql}`,
    [...params, ...limitParams],
  );
  return { rows, total: Number(totalRow?.total || 0) };
}

app.get("/api/inventory/logs", requireAuth, readScope, async (req, res, next) => {
  try {
    const limit = normalizePageLimit(req.query.limit);
    const offset = normalizeOffset(req.query.offset);
    res.json(await queryInventoryLogs(req.query, { limit, offset }));
  } catch (error) {
    next(error);
  }
});

async function queryInventoryAbnormalLogs(paging = {}) {
  const fromSql = `from inventory_abnormal_logs l
       join users u on u.id = l.operator_user_id
       join skus s on s.id = l.sku_id
       join products p on p.id = s.product_id
       join brands b on b.id = p.brand_id`;
  const [totalRow] = await query(`select count(*) as total ${fromSql}`);
  const limitSql = paging.limit ? " limit ? offset ?" : "";
  const limitParams = paging.limit ? [paging.limit, paging.offset || 0] : [];
  const rows = await query(
    `select l.id, l.quantity, l.stock_label as stockLabel, l.reason, date_format(l.created_at, '%Y-%m-%d %H:%i:%s') as createdAt,
        u.name as operatorName, b.name as brandName, p.name as productName, s.name as skuName
       ${fromSql}
       order by l.id desc${limitSql}`,
    limitParams,
  );
  return { rows, total: Number(totalRow?.total || 0) };
}

app.get("/api/inventory/abnormal-logs", requireAuth, readScope, async (req, res, next) => {
  try {
    const limit = normalizePageLimit(req.query.limit);
    const offset = normalizeOffset(req.query.offset);
    res.json(await queryInventoryAbnormalLogs({ limit, offset }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/checks", requireAuth, readScope, async (_req, res, next) => {
  try {
    res.json(await query(
      `select c.id, date_format(c.check_time, '%Y-%m-%d %H:%i:%s') as checkTime,
          u.name as operatorName, c.upload_file_path as uploadFilePath,
          c.is_synced as isSynced, date_format(c.synced_at, '%Y-%m-%d %H:%i:%s') as syncedAt,
          if(c.is_synced = 0 and timestampdiff(minute, c.check_time, now()) <= 30, 1, 0) as canSync,
          count(d.id) as differenceCount
       from inventory_checks c
       join users u on u.id = c.operator_user_id
       left join inventory_check_differences d on d.check_id = c.id
       group by c.id, c.check_time, u.name, c.upload_file_path, c.is_synced, c.synced_at
       order by c.id desc`,
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/checks/:id(\\d+)", requireAuth, readScope, async (req, res, next) => {
  try {
    const checkId = Number(req.params.id);
    const record = await getInventoryCheckRecord(checkId);
    if (!record) return res.status(404).json({ message: "盘点记录不存在" });
    res.json({ record, rows: await listInventoryCheckDifferences(checkId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/checks/:id(\\d+)/sync", requireAuth, requireAnyPermission(["INVENTORY"]), async (req, res, next) => {
  try {
    const checkId = Number(req.params.id);
    if (!Number.isInteger(checkId) || checkId <= 0) throw badRequest("盘点记录ID不合法");
    await withTransaction(async (connection) => {
      const [recordRows] = await connection.execute(
        `select id, is_synced as isSynced, timestampdiff(minute, check_time, now()) as ageMinutes
         from inventory_checks
         where id = ?
         for update`,
        [checkId],
      );
      const record = recordRows[0];
      if (!record) throw badRequest("盘点记录不存在");
      if (Number(record.isSynced) === 1) throw badRequest("本次盘点差异已经同步过");
      if (Number(record.ageMinutes) > 30) throw badRequest("只能同步30分钟内的盘点差异");

      const [differences] = await connection.execute(
        `select sku_id as skuId, salable_diff_qty as salableDiffQty, unsalable_diff_qty as unsalableDiffQty
         from inventory_check_differences
         where check_id = ?
         order by id`,
        [checkId],
      );

      for (const difference of differences) {
        const salableDiffQty = Number(difference.salableDiffQty || 0);
        const unsalableDiffQty = Number(difference.unsalableDiffQty || 0);
        if (salableDiffQty === 0 && unsalableDiffQty === 0) continue;
        const [stockRows] = await connection.execute(
          "select salable_qty, unsalable_qty from sku_inventory where sku_id = ? for update",
          [difference.skuId],
        );
        const stock = stockRows[0];
        if (!stock) throw badRequest("规格库存不存在");
        await connection.execute(
          "update sku_inventory set salable_qty = ?, unsalable_qty = ? where sku_id = ?",
          [
            Number(stock.salable_qty) + salableDiffQty,
            Number(stock.unsalable_qty) + unsalableDiffQty,
            difference.skuId,
          ],
        );
        if (salableDiffQty !== 0) {
          await connection.execute(
            `insert into inventory_abnormal_logs (sku_id, stock_label, quantity, reason, operator_user_id)
             values(?, 1, ?, ?, ?)`,
            [difference.skuId, salableDiffQty, "库存盘点异常同步", req.user.id],
          );
        }
        if (unsalableDiffQty !== 0) {
          await connection.execute(
            `insert into inventory_abnormal_logs (sku_id, stock_label, quantity, reason, operator_user_id)
             values(?, 2, ?, ?, ?)`,
            [difference.skuId, unsalableDiffQty, "库存盘点异常同步", req.user.id],
          );
        }
      }

      await connection.execute("update inventory_checks set is_synced = 1, synced_at = now() where id = ?", [checkId]);
    });

    res.json({ record: await getInventoryCheckRecord(checkId), rows: await listInventoryCheckDifferences(checkId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/checks/:id(\\d+)/file", requireAuth, readScope, async (req, res, next) => {
  try {
    const record = await getInventoryCheckRecord(Number(req.params.id));
    if (!record) return res.status(404).json({ message: "盘点记录不存在" });
    if (!record.uploadFilePath) return res.status(404).json({ message: "该盘点记录没有上传文件" });
    const absolutePath = path.resolve(projectRoot, ...String(record.uploadFilePath).split("/"));
    if (!absolutePath.startsWith(path.resolve(projectRoot, "uploads", "inventory-checks") + path.sep)) {
      return res.status(400).json({ message: "文件路径不合法" });
    }
    res.download(absolutePath, `盘点数据-${record.checkTime.replace(/[^\d]/g, "").slice(0, 14)}${path.extname(absolutePath) || ".xlsx"}`);
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ message: "上传文件不存在" });
    next(error);
  }
});

app.get("/api/inventory/checks/:id(\\d+)/export", requireAuth, readScope, async (req, res, next) => {
  try {
    const record = await getInventoryCheckRecord(Number(req.params.id));
    if (!record) return res.status(404).json({ message: "盘点记录不存在" });
    const workbook = await buildInventoryCheckDifferenceWorkbook(record.id);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=inventory-check-detail.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inventory/checks/template", requireAuth, readScope, async (_req, res, next) => {
  try {
    const workbook = await buildInventoryCheckTemplateWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=inventory-check-template.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.post("/api/inventory/checks/upload", requireAuth, requireAnyPermission(["INVENTORY"]), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest("请上传Excel文件");
    const uploadFilePath = await saveInventoryCheckUploadFile(req.file);
    res.status(201).json(await importInventoryCheckWorkbook(req.file.buffer, req.user.id, uploadFilePath));
  } catch (error) {
    next(error);
  }
});

function normalizeDays(value) {
  const days = Number(value || 7);
  return [7, 15, 30].includes(days) ? days : 7;
}

function parseBrandIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const next = startOfDay(date);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function buildTrendBuckets(period) {
  const today = startOfDay(new Date());
  if (period === "week") {
    const currentWeek = startOfWeek(today);
    return Array.from({ length: 8 }, (_, index) => {
      const start = new Date(currentWeek);
      start.setDate(start.getDate() - (7 - index) * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { label: `${dateKey(start).slice(5)}~${dateKey(end).slice(5)}`, start, end };
    });
  }
  if (period === "month") {
    return Array.from({ length: 6 }, (_, index) => {
      const start = new Date(today.getFullYear(), today.getMonth() - (5 - index), 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
      return { label: monthKey(start), start, end };
    });
  }
  return Array.from({ length: 15 }, (_, index) => {
    const start = new Date(today);
    start.setDate(start.getDate() - (14 - index));
    return { label: dateKey(start), start, end: start };
  });
}

app.get("/api/stats/sales/brand-products", requireAuth, readScope, async (req, res, next) => {
  try {
    const brandId = Number(req.query.brandId || 0);
    if (!brandId) throw badRequest("请选择品牌");
    const days = normalizeDays(req.query.days);
    const rows = await query(
      `select p.id as productId, p.name as productName, s.id as skuId, s.name as skuName, sum(l.quantity) as quantity
       from inventory_operation_logs l
       join skus s on s.id = l.sku_id
       join products p on p.id = s.product_id
       join brands b on b.id = p.brand_id
       where l.operation_type = 2 and l.stock_label = 1 and b.id = ? and l.created_at >= date_sub(now(), interval ? day)
       group by p.id, p.name, s.id, s.name
       order by sum(l.quantity) desc`,
      [brandId, days],
    );
    const byProduct = new Map();
    for (const row of rows) {
      const product = byProduct.get(row.productId) || { productId: row.productId, productName: row.productName, totalQty: 0, skus: [] };
      product.totalQty += Number(row.quantity);
      if (Number(row.quantity) > 0) product.skus.push({ skuId: row.skuId, skuName: row.skuName, quantity: Number(row.quantity) });
      byProduct.set(row.productId, product);
    }
    res.json(
      [...byProduct.values()]
        .sort((a, b) => b.totalQty - a.totalQty)
        .slice(0, 5)
        .map((product) => ({
          ...product,
          skus: product.skus.sort((a, b) => b.quantity - a.quantity).slice(0, 5),
        })),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/stats/sales/product-top", requireAuth, readScope, async (req, res, next) => {
  try {
    const days = normalizeDays(req.query.days);
    res.json(
      await query(
        `select p.id as productId, b.name as brandName, p.name as productName, sum(l.quantity) as quantity
         from inventory_operation_logs l
         join skus s on s.id = l.sku_id
         join products p on p.id = s.product_id
         join brands b on b.id = p.brand_id
         where l.operation_type = 2 and l.stock_label = 1 and l.created_at >= date_sub(now(), interval ? day)
         group by p.id, b.name, p.name
         order by sum(l.quantity) desc
         limit 10`,
        [days],
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/stats/sales/trend", requireAuth, readScope, async (req, res, next) => {
  try {
    const period = ["day", "week", "month"].includes(req.query.period) ? req.query.period : "day";
    const brandIds = parseBrandIds(req.query.brandIds);
    const buckets = buildTrendBuckets(period);
    const start = dateKey(buckets[0].start);
    const params = [start];
    const brandFilter = brandIds.length ? ` and b.id in (${brandIds.map(() => "?").join(",")})` : "";
    params.push(...brandIds);
    const rows = await query(
      `select date_format(l.created_at, '%Y-%m-%d') as day, sum(l.quantity) as quantity
       from inventory_operation_logs l
       join skus s on s.id = l.sku_id
       join products p on p.id = s.product_id
       join brands b on b.id = p.brand_id
       where l.operation_type = 2 and l.stock_label = 1 and l.created_at >= ?${brandFilter}
       group by date_format(l.created_at, '%Y-%m-%d')`,
      params,
    );
    const values = buckets.map((bucket) => {
      const bucketStart = bucket.start.getTime();
      const bucketEnd = bucket.end.getTime();
      return rows.reduce((sum, row) => {
        const current = new Date(`${row.day}T00:00:00`).getTime();
        return current >= bucketStart && current <= bucketEnd ? sum + Number(row.quantity) : sum;
      }, 0);
    });
    res.json({ labels: buckets.map((bucket) => bucket.label), values });
  } catch (error) {
    next(error);
  }
});

function normalizeSalesAmountDateRange(source) {
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(source.startDate || ""))
    ? String(source.startDate)
    : dateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(source.endDate || ""))
    ? String(source.endDate)
    : dateKey(new Date());
  return { startDate, endDate };
}

async function querySalesAmountRows(filters) {
  const { startDate, endDate } = normalizeSalesAmountDateRange(filters);
  const rows = await query(
    `select b.id as brandId, b.name as brandName,
      p.id as productId, p.name as productName,
      s.id as skuId, s.name as skuName, s.purchase_price as purchasePrice,
      sum(case when l.operation_type = 2 then l.quantity else -l.quantity end) as salesQty,
      sum(case when l.operation_type = 2 then l.quantity * s.purchase_price else -l.quantity * s.purchase_price end) as costAmount
     from inventory_operation_logs l
     join skus s on s.id = l.sku_id
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where (l.operation_type = 2 or (l.operation_type = 1 and l.inbound_type = 2))
       and l.created_at >= ? and l.created_at < date_add(?, interval 1 day)
     group by b.id, b.name, b.sort_order, p.id, p.name, p.sort_order, s.id, s.name, s.sort_order, s.purchase_price
     order by b.sort_order, b.id, p.sort_order, p.id, s.sort_order, s.id`,
    [startDate, endDate],
  );
  const platformRows = await query(
    `select b.id as brandId,
       case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' when 3 then 'kuaishou' else 'none' end as platform,
       sum(case when l.operation_type = 2 then l.quantity * s.purchase_price else -l.quantity * s.purchase_price end) as amount
     from inventory_operation_logs l
     join skus s on s.id = l.sku_id
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where (l.operation_type = 2 or (l.operation_type = 1 and l.inbound_type = 2))
       and l.created_at >= ? and l.created_at < date_add(?, interval 1 day)
     group by b.id, platform`,
    [startDate, endDate],
  );
  const platformAmounts = new Map();
  for (const row of platformRows) {
    const current = platformAmounts.get(row.brandId) || { douyin: 0, pinduoduo: 0, kuaishou: 0, none: 0 };
    current[row.platform] = Number(row.amount || 0);
    platformAmounts.set(row.brandId, current);
  }
  return rows.map((row) => ({
    ...row,
    brandPlatformAmounts: platformAmounts.get(row.brandId) || { douyin: 0, pinduoduo: 0, kuaishou: 0, none: 0 },
  }));
}

async function querySalesAmountPlatformBreakdown(filters) {
  const { startDate, endDate } = normalizeSalesAmountDateRange(filters);
  return query(
    `select b.id as brandId, p.id as productId, s.id as skuId,
       case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' when 3 then 'kuaishou' else 'none' end as platform,
       sum(case when l.operation_type = 2 then l.quantity * s.purchase_price else -l.quantity * s.purchase_price end) as amount
     from inventory_operation_logs l
     join skus s on s.id = l.sku_id
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where (l.operation_type = 2 or (l.operation_type = 1 and l.inbound_type = 2))
       and l.created_at >= ? and l.created_at < date_add(?, interval 1 day)
     group by b.id, p.id, s.id, platform`,
    [startDate, endDate],
  );
}

app.get("/api/stats/sales/amount", requireAuth, readScope, async (req, res, next) => {
  try {
    res.json(await querySalesAmountRows(req.query));
  } catch (error) {
    next(error);
  }
});

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF475569" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    cell.border = borderStyle();
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
}

function borderStyle() {
  return {
    top: { style: "thin", color: { argb: "FFE2E8F0" } },
    left: { style: "thin", color: { argb: "FFE2E8F0" } },
    bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
    right: { style: "thin", color: { argb: "FFE2E8F0" } },
  };
}

function styleDataRow(row, options = {}) {
  row.eachCell((cell) => {
    cell.border = borderStyle();
    cell.alignment = { vertical: "middle" };
    if (options.hidden) cell.font = { color: { argb: "FF94A3B8" } };
    if (options.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: options.fill } };
  });
}

function autoWidth(sheet) {
  sheet.columns.forEach((column) => {
    let width = 10;
    column.eachCell({ includeEmpty: true }, (cell) => {
      width = Math.max(width, String(cell.value ?? "").length + 4);
    });
    column.width = Math.min(Math.max(width, 12), 28);
  });
}

function mergeSame(sheet, startRow, endRow, columns, keyGetter) {
  for (const col of columns) {
    let start = startRow;
    while (start <= endRow) {
      const key = keyGetter(start, col);
      let end = start;
      while (end + 1 <= endRow && keyGetter(end + 1, col) === key) end += 1;
      if (end > start) sheet.mergeCells(start, col, end, col);
      sheet.getCell(start, col).alignment = { vertical: "middle", horizontal: "center" };
      start = end + 1;
    }
  }
}

function addRowsSheet(workbook, name, headers, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  styleHeader(sheet.getRow(1));
  rows.forEach((row) => {
    const dataRow = sheet.addRow(row.values);
    styleDataRow(dataRow, { hidden: row.hidden, fill: row.fill });
    if (row.fill && row.fillFromColumn) {
      for (let columnIndex = 1; columnIndex < row.fillFromColumn; columnIndex += 1) {
        dataRow.getCell(columnIndex).fill = undefined;
      }
    }
  });
  autoWidth(sheet);
  return sheet;
}

function collectProductInventory(catalog) {
  const byProduct = new Map();
  for (const row of catalog) {
    const current = byProduct.get(row.productId) || {
      brandId: row.brandId,
      brandName: row.brandName,
      productId: row.productId,
      productName: row.productName,
      totalQty: 0,
      salableQty: 0,
      unsalableQty: 0,
    };
    current.salableQty += Number(row.salableQty);
    current.unsalableQty += Number(row.unsalableQty);
    current.totalQty = current.salableQty + current.unsalableQty;
    byProduct.set(row.productId, current);
  }
  return [...byProduct.values()];
}

function addProductInventorySheet(workbook, rows) {
  const totalQty = rows.reduce((sum, row) => sum + Number(row.totalQty), 0);
  const sheet = workbook.addWorksheet("库存总计");
  sheet.addRow(["品牌名", "商品名", "库存总量", "可售库存数", "不可售库存数", "占有率"]);
  styleHeader(sheet.getRow(1));

  for (let index = 0; index < rows.length;) {
    const brandRows = rows.filter((row) => row.brandId === rows[index].brandId);
    const startRow = sheet.rowCount + 1;
    const brandTotal = brandRows.reduce(
      (sum, row) => ({
        totalQty: sum.totalQty + Number(row.totalQty),
        salableQty: sum.salableQty + Number(row.salableQty),
        unsalableQty: sum.unsalableQty + Number(row.unsalableQty),
      }),
      { totalQty: 0, salableQty: 0, unsalableQty: 0 },
    );

    for (const row of brandRows) {
      styleDataRow(sheet.addRow([
        row.brandName,
        row.productName,
        row.totalQty,
        row.salableQty,
        row.unsalableQty,
        totalQty ? `${Math.floor((Number(row.totalQty) / totalQty) * 100)}%` : "0%",
      ]));
    }

    styleDataRow(sheet.addRow([
      rows[index].brandName,
      "总计",
      brandTotal.totalQty,
      brandTotal.salableQty,
      brandTotal.unsalableQty,
      totalQty ? `${Math.floor((brandTotal.totalQty / totalQty) * 100)}%` : "0%",
    ]), { fill: "FFFFF7CC" });

    if (brandRows.length > 0) sheet.mergeCells(startRow, 1, sheet.rowCount, 1);
    sheet.getCell(startRow, 1).alignment = { vertical: "middle", horizontal: "center" };
    index += brandRows.length;
  }
  autoWidth(sheet);
}

function sqlValue(value) {
  if (value === null || value === undefined || value === "") return "''";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sheetRows(workbook, name) {
  const legacyNames = { 库存明细: "SKU库存明细", 库存操作: "操作日志", 库存总计: "商品库存总计" };
  const sheet = workbook.getWorksheet(name) || workbook.getWorksheet(legacyNames[name]);
  if (!sheet) return [];
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value || ""));
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const item = {};
    headers.forEach((header, headerIndex) => {
      item[header] = row.getCell(headerIndex + 1).value ?? "";
    });
    if (Object.values(item).some((value) => value !== "")) rows.push(item);
  });
  return rows;
}

function addInventoryDetailSheet(workbook, catalog) {
  const inventorySheet = addRowsSheet(
    workbook,
    "库存明细",
    ["品牌名", "商品名", "规格名", "库存总量", "可售库存数", "不可售库存数"],
    catalog.map((row) => {
      const salable = Number(row.salableQty);
      return {
        values: [row.brandName, row.productName, row.skuName, salable + Number(row.unsalableQty), salable, Number(row.unsalableQty)],
        fill: salable === 0 ? "FFFFE4E6" : salable === 1 ? "FFFFF7CC" : undefined,
        fillFromColumn: 3,
      };
    }),
  );
  if (catalog.length) mergeSame(inventorySheet, 2, catalog.length + 1, [1, 2], (row, col) => `${col === 1 ? "" : inventorySheet.getCell(row, 1).value}-` + inventorySheet.getCell(row, col).value);
  return inventorySheet;
}

function addInventoryCheckTemplateSheet(workbook, catalog) {
  const sheet = addRowsSheet(
    workbook,
    "库存盘点",
    ["品牌名", "商品名", "规格名", "可售库存数", "不可售库存数"],
    catalog.map((row) => ({
      values: [row.brandName, row.productName, row.skuName, Number(row.salableQty), Number(row.unsalableQty)],
    })),
  );
  if (catalog.length) mergeSame(sheet, 2, catalog.length + 1, [1, 2], (row, col) => `${col === 1 ? "" : sheet.getCell(row, 1).value}-` + sheet.getCell(row, col).value);
  sheet.getColumn(4).width = 16;
  sheet.getColumn(5).width = 18;
  return sheet;
}

function worksheetRowsWithMergedNames(workbook, name) {
  const sheet = workbook.getWorksheet(name) || workbook.worksheets[0];
  if (!sheet) return [];
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value || "").trim());
  const rows = [];
  let brandName = "";
  let productName = "";
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const item = {};
    headers.forEach((header, headerIndex) => {
      item[header] = row.getCell(headerIndex + 1).value ?? "";
    });
    if (item["品牌名"]) brandName = String(item["品牌名"]).trim();
    if (item["商品名"]) productName = String(item["商品名"]).trim();
    item["品牌名"] = brandName;
    item["商品名"] = productName;
    if (Object.values(item).some((value) => value !== "")) {
      item.__rowNumber = index;
      rows.push(item);
    }
  });
  return rows;
}

function parseInventoryCountNumber(value, label, rowNumber) {
  if (value === null || value === undefined || value === "") return 0;
  if (value === null || value === undefined || value === "") throw badRequest(`第${rowNumber}行${label}不能为空`);
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) throw badRequest(`第${rowNumber}行${label}必须是整数`);
  return numberValue;
}

async function saveInventoryCheckUploadFile(file) {
  await fs.mkdir(inventoryCheckUploadDir, { recursive: true });
  const ext = path.extname(file.originalname || "").toLowerCase();
  const safeExt = [".xlsx", ".xls"].includes(ext) ? ext : ".xlsx";
  const fileName = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}${safeExt}`;
  const relativePath = path.posix.join("uploads", "inventory-checks", fileName);
  await fs.writeFile(path.join(projectRoot, ...relativePath.split("/")), file.buffer);
  return relativePath;
}

async function buildInventoryCheckTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  addInventoryCheckTemplateSheet(workbook, await listCatalog({ excludeSupplementBrands: true }));
  return workbook;
}

async function getInventoryCheckRecord(checkId) {
  const rows = await query(
    `select c.id, date_format(c.check_time, '%Y-%m-%d %H:%i:%s') as checkTime,
        u.name as operatorName, c.upload_file_path as uploadFilePath,
        c.is_synced as isSynced, date_format(c.synced_at, '%Y-%m-%d %H:%i:%s') as syncedAt,
        if(c.is_synced = 0 and timestampdiff(minute, c.check_time, now()) <= 30, 1, 0) as canSync,
        count(d.id) as differenceCount
     from inventory_checks c
     join users u on u.id = c.operator_user_id
     left join inventory_check_differences d on d.check_id = c.id
     where c.id = ?
     group by c.id, c.check_time, u.name, c.upload_file_path, c.is_synced, c.synced_at`,
    [checkId],
  );
  return rows[0] || null;
}

async function listInventoryCheckDifferences(checkId) {
  return query(
    `select d.id, d.check_id as checkId, d.sku_id as skuId,
        brand_name as brandName, product_name as productName, sku_name as skuName,
        system_salable_qty as systemSalableQty,
        system_unsalable_qty as systemUnsalableQty,
        actual_salable_qty as actualSalableQty,
        actual_unsalable_qty as actualUnsalableQty,
        salable_diff_qty as salableDiffQty,
        unsalable_diff_qty as unsalableDiffQty,
        coalesce(nullif(d.purchase_price_snapshot, 0), s.purchase_price, 0) as purchasePrice,
        salable_diff_qty * coalesce(nullif(d.purchase_price_snapshot, 0), s.purchase_price, 0) as salableDiffAmount,
        unsalable_diff_qty * coalesce(nullif(d.purchase_price_snapshot, 0), s.purchase_price, 0) as unsalableDiffAmount
     from inventory_check_differences d
     left join skus s on s.id = d.sku_id
     where d.check_id = ?
     order by d.id`,
    [checkId],
  );
}

async function importInventoryCheckWorkbook(buffer, operatorUserId, uploadFilePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows = worksheetRowsWithMergedNames(workbook, "库存盘点");
  if (!rows.length) throw badRequest("盘点表不能为空");
  const catalog = await listCatalog();
  const catalogMap = new Map(catalog.map((row) => [`${row.brandName}\u0001${row.productName}\u0001${row.skuName}`, row]));
  const differences = [];

  for (const row of rows) {
    const brandName = String(row["品牌名"] || "").trim();
    const productName = String(row["商品名"] || "").trim();
    const skuName = String(row["规格名"] || "").trim();
    if (!brandName || !productName || !skuName) throw badRequest(`第${row.__rowNumber}行品牌名、商品名、规格名不能为空`);
    const catalogRow = catalogMap.get(`${brandName}\u0001${productName}\u0001${skuName}`);
    if (!catalogRow) throw badRequest(`第${row.__rowNumber}行未找到对应库存：${brandName}/${productName}/${skuName}`);
    const actualSalableQty = parseInventoryCountNumber(row["可售库存数"], "可售库存数", row.__rowNumber);
    const actualUnsalableQty = parseInventoryCountNumber(row["不可售库存数"], "不可售库存数", row.__rowNumber);
    const systemSalableQty = Number(catalogRow.salableQty);
    const systemUnsalableQty = Number(catalogRow.unsalableQty);
    const salableDiffQty = actualSalableQty - systemSalableQty;
    const unsalableDiffQty = actualUnsalableQty - systemUnsalableQty;
    if (salableDiffQty !== 0 || unsalableDiffQty !== 0) {
      differences.push({
        skuId: catalogRow.skuId,
        brandName,
        productName,
        skuName,
        systemSalableQty,
        systemUnsalableQty,
        actualSalableQty,
        actualUnsalableQty,
        salableDiffQty,
        unsalableDiffQty,
        purchasePrice: Number(catalogRow.purchasePrice),
      });
    }
  }

  const checkId = await withTransaction(async (connection) => {
    const [created] = await connection.execute(
      "insert into inventory_checks(operator_user_id, upload_file_path) values(?, ?)",
      [operatorUserId, uploadFilePath],
    );
    for (const item of differences) {
      await connection.execute(
        `insert into inventory_check_differences
          (check_id, sku_id, brand_name, product_name, sku_name,
           system_salable_qty, system_unsalable_qty, actual_salable_qty, actual_unsalable_qty,
           salable_diff_qty, unsalable_diff_qty, purchase_price_snapshot)
         values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          created.insertId,
          item.skuId,
          item.brandName,
          item.productName,
          item.skuName,
          item.systemSalableQty,
          item.systemUnsalableQty,
          item.actualSalableQty,
          item.actualUnsalableQty,
          item.salableDiffQty,
          item.unsalableDiffQty,
          item.purchasePrice,
        ],
      );
    }
    return created.insertId;
  });

  return {
    record: await getInventoryCheckRecord(checkId),
    rows: await listInventoryCheckDifferences(checkId),
  };
}

function addInventoryLogsSheet(workbook, logs) {
  const logSheet = addRowsSheet(
    workbook,
    "库存操作",
    ["时间", "类型", "品牌名", "商品名", "规格名", "入库类型", "标签", "平台", "数量", "操作人", "备注"],
    logs.map((row) => ({
      values: [
        row.createdAt,
        row.operationType === 1 ? "入库" : "出库",
        row.brandName,
        row.productName,
        row.skuName,
        row.operationType === 1 ? (row.inboundType === 1 ? "新货" : "退货") : "",
        row.stockLabel === 1 ? "可售" : "不可售",
        row.platform === "douyin" ? "抖音" : row.platform === "pinduoduo" ? "拼多多" : row.platform === "kuaishou" ? "快手" : "",
        row.quantity,
        row.operatorName,
        row.remark,
      ],
    })),
  );
  logSheet.eachRow((row, index) => {
    if (index === 1) return;
    const typeCell = row.getCell(2);
    typeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: typeCell.value === "出库" ? "FFDCFCE7" : "FFFEF9C3" } };
    if (row.getCell(6).value === "退货") row.getCell(6).font = { color: { argb: "FFDC2626" }, bold: true };
    if (row.getCell(7).value === "不可售") row.getCell(7).font = { color: { argb: "FFDC2626" }, bold: true };
  });
  autoWidth(logSheet);
  return logSheet;
}

async function buildInventoryDetailWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  addInventoryDetailSheet(workbook, await listCatalog({ excludeSupplementBrands: true }));
  return workbook;
}

async function buildSkuWorkbook(filters = {}) {
  const productId = Number(filters.productId || 0);
  const brandId = Number(filters.brandId || 0);
  const rows = await query(
    `select s.id, s.product_id as productId, p.name as productName, b.id as brandId, b.name as brandName,
       s.name as skuName, s.purchase_price as purchasePrice, s.remark, s.sort_order as sortOrder, s.is_hidden as isHidden
     from skus s
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where s.deleted_at is null and p.deleted_at is null and b.deleted_at is null
       and (? = 0 or s.product_id = ?)
       and (? = 0 or b.id = ?)
     order by b.is_hidden, b.sort_order, b.id, p.is_hidden, p.sort_order, p.id, s.is_hidden, s.sort_order, s.id`,
    [productId, productId, brandId, brandId],
  );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const sheet = addRowsSheet(
    workbook,
    "SKU管理",
    ["品牌名", "商品名", "规格名", "购入价格", "备注", "是否隐藏"],
    rows.map((row) => ({
      values: [
        row.brandName,
        row.productName,
        row.skuName,
        Number(row.purchasePrice),
        row.remark || "",
        row.isHidden ? "隐藏" : "显示",
      ],
      hidden: row.isHidden,
    })),
  );
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    sheet.getCell(rowNumber, 4).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1, 2], (row, col) => `${col === 1 ? "" : sheet.getCell(row, 1).value}-` + sheet.getCell(row, col).value);
  }
  autoWidth(sheet);
  return workbook;
}

async function buildInventoryAmountWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const rows = (await listCatalog()).map((row) => {
    const salableQty = Number(row.salableQty);
    const unsalableQty = Number(row.unsalableQty);
    const purchasePrice = Number(row.purchasePrice);
    return {
      ...row,
      salableQty,
      unsalableQty,
      salableAmount: salableQty * purchasePrice,
      unsalableAmount: unsalableQty * purchasePrice,
    };
  });
  const productTotals = new Map();
  const brandTotals = new Map();
  const brandUnsalableTotals = new Map();
  for (const row of rows) {
    productTotals.set(row.productId, (productTotals.get(row.productId) || 0) + row.salableAmount);
    brandTotals.set(row.brandId, (brandTotals.get(row.brandId) || 0) + row.salableAmount);
    brandUnsalableTotals.set(row.brandId, (brandUnsalableTotals.get(row.brandId) || 0) + row.unsalableAmount);
  }
  const sheet = addRowsSheet(
    workbook,
    "库存金额",
    ["品牌名", "商品名", "规格名", "可售库存", "库存金额", "商品总金额", "品牌总金额", "不可售库存量", "不可售库存金额", "品牌总不可售金额"],
    rows.map((row) => ({
      values: [
        row.brandName,
        row.productName,
        row.skuName,
        row.salableQty,
        row.salableAmount,
        productTotals.get(row.productId) || 0,
        brandTotals.get(row.brandId) || 0,
        row.unsalableQty,
        row.unsalableAmount,
        brandUnsalableTotals.get(row.brandId) || 0,
      ],
    })),
  );
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    for (const columnNumber of [5, 6, 7, 9, 10]) {
      sheet.getCell(rowNumber, columnNumber).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
    }
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1, 7, 10], (row) => sheet.getCell(row, 1).value);
    mergeSame(sheet, 2, rows.length + 1, [2, 6], (row) => `${sheet.getCell(row, 1).value}-${sheet.getCell(row, 2).value}`);
  }
  autoWidth(sheet);
  return workbook;
}

function getZonedDateParts(date = new Date(), timeZone = process.env.SCHEDULE_TIME_ZONE || "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return { year: map.year, month: map.month, day: map.day, hour: map.hour, minute: map.minute };
}

function isMonthlyInventoryEmailDue(date = new Date()) {
  const parts = getZonedDateParts(date);
  const lastDay = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  return parts.day === lastDay && parts.hour === 22;
}

function formatMonthlyInventoryJobKey(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `monthly-inventory-amount-${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function formatMonthlyInventoryFileName(date = new Date()) {
  const parts = getZonedDateParts(date);
  return `${parts.year}年${parts.month}月${parts.day}日${parts.hour}时${String(parts.minute).padStart(2, "0")}分_库存金额.xlsx`;
}

function formatDateOnly(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getTodayDateRange(date = new Date()) {
  const parts = getZonedDateParts(date);
  const dateText = formatDateOnly(parts);
  return { dateText, startAt: `${dateText} 00:00:00`, endAt: `${dateText} 23:59:59`, parts };
}

function isDailySalesEmailDue(date = new Date()) {
  const parts = getZonedDateParts(date);
  return parts.hour === 21;
}

async function claimScheduledEmailJob(jobKey, jobType = "monthly_inventory_amount_email") {
  const rows = await query("select status, timestampdiff(minute, updated_at, now()) as runningMinutes from scheduled_email_jobs where job_key = ?", [jobKey]);
  if (rows[0]?.status === 2) return false;
  if (rows[0]?.status === 1 && Number(rows[0]?.runningMinutes || 0) < 30) return false;
  if (rows.length === 0) {
    await query(
      "insert into scheduled_email_jobs(job_key, job_type, status, run_at) values(?, ?, 1, now())",
      [jobKey, jobType],
    );
    return true;
  }
  await query("update scheduled_email_jobs set status = 1, message = '' where job_key = ?", [jobKey]);
  return true;
}

async function updateScheduledEmailJob(jobKey, status, recipients, message) {
  await query(
    "update scheduled_email_jobs set status = ?, sent_at = if(? = 2, now(), sent_at), recipients = ?, message = ? where job_key = ?",
    [status, status, recipients, String(message || "").slice(0, 500), jobKey],
  );
}

async function findFinanceEmailRecipients() {
  return query(
    `select distinct u.email
     from users u
     join user_permissions up on up.user_id = u.id
     join permissions p on p.code = up.permission_code
     where u.deleted_at is null
       and u.status = 1
       and p.name = 'FINANCE'
       and u.email is not null
       and u.email <> ''
     order by u.id`,
  );
}

async function findBrandSalesSubscribers() {
  const rows = await query(
    `select u.id, u.name, u.email, group_concat(ubs.brand_id order by b.sort_order, b.id) as brandIds
     from users u
     join user_brand_subscriptions ubs on ubs.user_id = u.id
     join brands b on b.id = ubs.brand_id and b.deleted_at is null
     where u.deleted_at is null
       and u.status = 1
       and u.email is not null
       and u.email <> ''
     group by u.id, u.name, u.email
     order by u.id`,
  );
  return rows.map((row) => ({
    ...row,
    brandIds: String(row.brandIds || "").split(",").filter(Boolean).map(Number),
  })).filter((row) => row.brandIds.length > 0);
}

async function queryDailyBrandSkuRows(brandIds, startAt, endAt, mode) {
  if (!brandIds.length) return [];
  const params = [...brandIds, startAt, endAt];
  const typeFilter = mode === "return" ? "l.operation_type = 1 and l.inbound_type = 2" : "l.operation_type = 2";
  return query(
    `select b.id as brandId, b.name as brandName,
       p.id as productId, p.name as productName,
       s.id as skuId, s.name as skuName,
       sum(l.quantity) as quantity,
       sum(l.quantity * s.purchase_price) as amount
     from inventory_operation_logs l
     join skus s on s.id = l.sku_id
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where b.id in (${brandIds.map(() => "?").join(",")})
       and ${typeFilter}
       and l.created_at between ? and ?
     group by b.id, b.name, p.id, p.name, s.id, s.name
     order by b.sort_order, b.id, p.sort_order, p.id, s.sort_order, s.id`,
    params,
  );
}

function addDailySalesSkuSheet(workbook, name, rows, quantityTitle = "销售数量", amountTitle = "销售金额") {
  const sheet = addRowsSheet(
    workbook,
    name,
    ["品牌名", "商品名", "规格名", quantityTitle, amountTitle, "品牌总金额", "所有品牌销售总金额"],
    rows.length ? rows.map((row) => ({
      values: [row.brandName, row.productName, row.skuName, row.quantity, row.amount, row.brandTotalAmount, row.grandTotalAmount],
    })) : [{ values: ["无数据", "", "", 0, 0, 0, 0] }],
  );
  for (let rowNumber = 2; rowNumber <= Math.max(rows.length, 1) + 1; rowNumber += 1) {
    for (const columnNumber of [5, 6, 7]) {
      sheet.getCell(rowNumber, columnNumber).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
    }
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1, 6], (row) => sheet.getCell(row, 1).value);
    mergeSame(sheet, 2, rows.length + 1, [2], (row) => `${sheet.getCell(row, 1).value}-${sheet.getCell(row, 2).value}`);
    mergeSame(sheet, 2, rows.length + 1, [7], () => "grand-total");
  }
  autoWidth(sheet);
  return sheet;
}

function buildDailySalesSkuWorkbook({ salesRows, returnRows, dateText }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  workbook.created = new Date();
  addDailySalesSkuSheet(workbook, `${dateText}销售`, salesRows, "销售数量", "销售金额");
  addDailySalesSkuSheet(workbook, `${dateText}退货`, returnRows, "退货数量", "退货金额");
  return workbook;
}

function renderDailySalesSkuHtmlTable(title, rows, quantityTitle = "销售数量", amountTitle = "销售金额") {
  const style = "border:1px solid #6b7280;padding:6px;text-align:left;vertical-align:middle;";
  const headerStyle = `${style}font-weight:700;background:#f8fafc;`;
  const header = `<thead><tr><th style="${headerStyle}">品牌名</th><th style="${headerStyle}">商品名</th><th style="${headerStyle}">规格名</th><th style="${headerStyle}">${htmlEscape(quantityTitle)}</th><th style="${headerStyle}">${htmlEscape(amountTitle)}</th><th style="${headerStyle}">品牌总金额</th><th style="${headerStyle}">所有品牌销售总金额</th></tr></thead>`;
  if (!rows.length) {
    return `<h3>${htmlEscape(title)}</h3><table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">${header}<tbody><tr><td style="${style}" colspan="7">无数据</td></tr></tbody></table>`;
  }

  const brandSpans = new Map();
  const productSpans = new Map();
  for (const row of rows) {
    brandSpans.set(row.brandId, (brandSpans.get(row.brandId) || 0) + 1);
    const productKey = `${row.brandId}-${row.productId}`;
    productSpans.set(productKey, (productSpans.get(productKey) || 0) + 1);
  }

  const body = rows.map((row, index) => {
    const previous = rows[index - 1];
    const productKey = `${row.brandId}-${row.productId}`;
    const isBrandStart = !previous || previous.brandId !== row.brandId;
    const isProductStart = isBrandStart || previous.productId !== row.productId;
    return `<tr>${
      isBrandStart ? `<td style="${style}" rowspan="${brandSpans.get(row.brandId)}">${htmlEscape(row.brandName)}</td>` : ""
    }${
      isProductStart ? `<td style="${style}" rowspan="${productSpans.get(productKey)}">${htmlEscape(row.productName)}</td>` : ""
    }<td style="${style}">${htmlEscape(row.skuName)}</td><td style="${style}">${row.quantity}</td><td style="${style}">¥${Number(row.amount).toFixed(2)}</td>${
      isBrandStart ? `<td style="${style}" rowspan="${brandSpans.get(row.brandId)}">¥${Number(row.brandTotalAmount).toFixed(2)}</td>` : ""
    }${
      index === 0 ? `<td style="${style}" rowspan="${rows.length}">¥${Number(row.grandTotalAmount).toFixed(2)}</td>` : ""
    }</tr>`;
  }).join("");
  return `<h3>${htmlEscape(title)}</h3><table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;">${header}<tbody>${body}</tbody></table>`;
}

async function queryDailyBrandProductRows(brandIds, startAt, endAt, mode) {
  if (!brandIds.length) return [];
  const params = [...brandIds, startAt, endAt];
  const typeFilter = mode === "return" ? "l.operation_type = 1 and l.inbound_type = 2" : "l.operation_type = 2";
  return query(
    `select b.id as brandId, b.name as brandName, p.id as productId, p.name as productName,
       sum(l.quantity) as quantity,
       sum(l.quantity * s.purchase_price) as amount
     from inventory_operation_logs l
     join skus s on s.id = l.sku_id
     join products p on p.id = s.product_id
     join brands b on b.id = p.brand_id
     where b.id in (${brandIds.map(() => "?").join(",")})
       and ${typeFilter}
       and l.created_at between ? and ?
     group by b.id, b.name, p.id, p.name
     order by b.sort_order, b.id, p.sort_order, p.id`,
    params,
  );
}

function withBrandAndGrandTotals(rows) {
  const brandTotals = new Map();
  let grandTotal = 0;
  for (const row of rows) {
    const amount = Number(row.amount || 0);
    brandTotals.set(row.brandId, (brandTotals.get(row.brandId) || 0) + amount);
    grandTotal += amount;
  }
  return rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity || 0),
    amount: Number(row.amount || 0),
    brandTotalAmount: brandTotals.get(row.brandId) || 0,
    grandTotalAmount: grandTotal,
  }));
}

function addDailySalesSheet(workbook, name, rows, quantityTitle = "销售数量", amountTitle = "销售金额") {
  const sheet = addRowsSheet(
    workbook,
    name,
    ["品牌名", "商品名", quantityTitle, amountTitle, "品牌总金额", "所有品牌销售总金额"],
    rows.length ? rows.map((row) => ({
      values: [row.brandName, row.productName, row.quantity, row.amount, row.brandTotalAmount, row.grandTotalAmount],
    })) : [{ values: ["无数据", "", 0, 0, 0, 0] }],
  );
  for (let rowNumber = 2; rowNumber <= Math.max(rows.length, 1) + 1; rowNumber += 1) {
    for (const columnNumber of [4, 5, 6]) {
      sheet.getCell(rowNumber, columnNumber).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
    }
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1, 5], (row) => sheet.getCell(row, 1).value);
    mergeSame(sheet, 2, rows.length + 1, [6], () => "grand-total");
  }
  autoWidth(sheet);
  return sheet;
}

function buildDailySalesWorkbook({ salesRows, returnRows, dateText }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  workbook.created = new Date();
  addDailySalesSheet(workbook, `${dateText}销售`, salesRows, "销售数量", "销售金额");
  addDailySalesSheet(workbook, `${dateText}退货`, returnRows, "退货数量", "退货金额");
  return workbook;
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function renderDailySalesHtmlTable(title, rows, quantityTitle = "销售数量", amountTitle = "销售金额") {
  const body = rows.length
    ? rows.map((row) => `<tr><td>${htmlEscape(row.brandName)}</td><td>${htmlEscape(row.productName)}</td><td>${row.quantity}</td><td>¥${Number(row.amount).toFixed(2)}</td><td>¥${Number(row.brandTotalAmount).toFixed(2)}</td><td>¥${Number(row.grandTotalAmount).toFixed(2)}</td></tr>`).join("")
    : "<tr><td colspan=\"6\">无数据</td></tr>";
  return `<h3>${htmlEscape(title)}</h3><table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-size:13px;"><thead><tr><th>品牌名</th><th>商品名</th><th>${htmlEscape(quantityTitle)}</th><th>${htmlEscape(amountTitle)}</th><th>品牌总金额</th><th>所有品牌销售总金额</th></tr></thead><tbody>${body}</tbody></table>`;
}

async function sendDailySalesSubscriptionEmail(subscriber, dateRange) {
  const salesRows = withBrandAndGrandTotals(await queryDailyBrandSkuRows(subscriber.brandIds, dateRange.startAt, dateRange.endAt, "sales"));
  const returnRows = withBrandAndGrandTotals(await queryDailyBrandSkuRows(subscriber.brandIds, dateRange.startAt, dateRange.endAt, "return"));
  const workbook = buildDailySalesSkuWorkbook({ salesRows, returnRows, dateText: dateRange.dateText });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const { default: nodemailer } = await import("nodemailer");
  const portNumber = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: portNumber,
    secure: String(process.env.SMTP_SECURE || (portNumber === 465 ? "true" : "false")).toLowerCase() === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: subscriber.email,
    subject: `${dateRange.dateText} 品牌销售日报`,
    html: `<p>${htmlEscape(subscriber.name)}，附件为今日订阅品牌销售日报。</p>${renderDailySalesSkuHtmlTable("今日销售数据", salesRows, "销售数量", "销售金额")}<br/>${renderDailySalesSkuHtmlTable("今日退货数据", returnRows, "退货数量", "退货金额")}`,
    attachments: [{
      filename: `${dateRange.dateText}_品牌销售日报.xlsx`,
      content: buffer,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });
  return { salesRows, returnRows };
}

async function sendMonthlyInventoryAmountEmail(jobKey) {
  if (!process.env.SMTP_HOST) {
    await updateScheduledEmailJob(jobKey, 3, "", "SMTP_HOST is not configured");
    console.warn("[monthly-inventory-email] SMTP_HOST is not configured");
    return;
  }
  const recipients = (await findFinanceEmailRecipients()).map((row) => row.email).filter(Boolean);
  if (recipients.length === 0) {
    await updateScheduledEmailJob(jobKey, 3, "", "No FINANCE users with email");
    console.warn("[monthly-inventory-email] No FINANCE users with email");
    return;
  }

  const { default: nodemailer } = await import("nodemailer");
  const portNumber = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: portNumber,
    secure: String(process.env.SMTP_SECURE || (portNumber === 465 ? "true" : "false")).toLowerCase() === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });

  const workbook = await buildInventoryAmountWorkbook();
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = formatMonthlyInventoryFileName();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: recipients.join(","),
    subject: "库存金额月度报表",
    text: "附件为本月月末库存金额 Excel 报表。",
    attachments: [{ filename: fileName, content: buffer, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  });
  await updateScheduledEmailJob(jobKey, 2, recipients.join(","), "sent");
  console.log(`[monthly-inventory-email] sent ${fileName} to ${recipients.join(",")}`);
}

async function checkMonthlyInventoryAmountEmailJob() {
  if (String(process.env.INVENTORY_AMOUNT_EMAIL_ENABLED || "true").toLowerCase() === "false") return;
  if (!isMonthlyInventoryEmailDue()) return;
  const jobKey = formatMonthlyInventoryJobKey();
  if (!(await claimScheduledEmailJob(jobKey))) return;
  try {
    await sendMonthlyInventoryAmountEmail(jobKey);
  } catch (error) {
    await updateScheduledEmailJob(jobKey, 3, "", error.message || "send failed");
    console.error("[monthly-inventory-email] failed", error);
  }
}

async function checkDailySalesSubscriptionEmailJob() {
  if (String(process.env.DAILY_SALES_EMAIL_ENABLED || "true").toLowerCase() === "false") return;
  if (!isDailySalesEmailDue()) return;
  if (!process.env.SMTP_HOST) {
    console.warn("[daily-sales-email] SMTP_HOST is not configured");
    return;
  }
  const dateRange = getTodayDateRange();
  const subscribers = await findBrandSalesSubscribers();
  for (const subscriber of subscribers) {
    const jobKey = `daily-sales-subscription-${dateRange.dateText}-user-${subscriber.id}`;
    if (!(await claimScheduledEmailJob(jobKey, "daily_sales_subscription_email"))) continue;
    try {
      await sendDailySalesSubscriptionEmail(subscriber, dateRange);
      await updateScheduledEmailJob(jobKey, 2, subscriber.email, "sent");
      console.log(`[daily-sales-email] sent ${dateRange.dateText} to ${subscriber.email}`);
    } catch (error) {
      await updateScheduledEmailJob(jobKey, 3, subscriber.email, error.message || "send failed");
      console.error("[daily-sales-email] failed", error);
    }
  }
}

function startMonthlyInventoryAmountEmailJob() {
  if (String(process.env.INVENTORY_AMOUNT_EMAIL_ENABLED || "true").toLowerCase() === "false") return;
  setTimeout(() => void checkMonthlyInventoryAmountEmailJob(), 5000);
  setInterval(() => void checkMonthlyInventoryAmountEmailJob(), 60 * 1000);
}

function startDailySalesSubscriptionEmailJob() {
  if (String(process.env.DAILY_SALES_EMAIL_ENABLED || "true").toLowerCase() === "false") return;
  setTimeout(() => void checkDailySalesSubscriptionEmailJob(), 7000);
  setInterval(() => void checkDailySalesSubscriptionEmailJob(), 60 * 1000);
}

async function buildInventoryLogsWorkbook(filters) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const { rows } = await queryInventoryLogs(filters);
  addInventoryLogsSheet(workbook, rows);
  return workbook;
}

async function buildInventoryCheckDifferenceWorkbook(checkId) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const rows = await listInventoryCheckDifferences(checkId);
  const sheet = addRowsSheet(
    workbook,
    "盘点详情",
    ["品牌名", "商品名", "规格名", "可售库存数", "不可售库存数", "实际可售库存数", "实际不可售库存数", "可售库存数差值", "可售差值金额", "不可售库存数差值", "不可售差值金额"],
    rows.map((row) => ({
      values: [
        row.brandName,
        row.productName,
        row.skuName,
        Number(row.systemSalableQty),
        Number(row.systemUnsalableQty),
        Number(row.actualSalableQty),
        Number(row.actualUnsalableQty),
        Number(row.salableDiffQty),
        Number(row.salableDiffAmount),
        Number(row.unsalableDiffQty),
        Number(row.unsalableDiffAmount),
      ],
    })),
  );
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    for (const columnNumber of [9, 11]) {
      sheet.getCell(rowNumber, columnNumber).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
    }
    for (const columnNumber of [8, 9]) {
      const value = Number(sheet.getCell(rowNumber, columnNumber).value || 0);
      if (value > 0) sheet.getCell(rowNumber, columnNumber).font = { color: { argb: "FF15803D" }, bold: true };
      if (value < 0) sheet.getCell(rowNumber, columnNumber).font = { color: { argb: "FFB91C1C" }, bold: true };
    }
    for (const columnNumber of [10, 11]) {
      const value = Number(sheet.getCell(rowNumber, columnNumber).value || 0);
      if (value > 0) sheet.getCell(rowNumber, columnNumber).font = { color: { argb: "FF15803D" }, bold: true };
      if (value < 0) sheet.getCell(rowNumber, columnNumber).font = { color: { argb: "FFB91C1C" }, bold: true };
    }
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1], (row) => sheet.getCell(row, 1).value);
    mergeSame(sheet, 2, rows.length + 1, [2], (row) => `${sheet.getCell(row, 1).value}-${sheet.getCell(row, 2).value}`);
  }
  autoWidth(sheet);
  return workbook;
}

async function buildSalesAmountWorkbook(filters) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const rows = await querySalesAmountRows(filters);
  const platformRows = await querySalesAmountPlatformBreakdown(filters);
  const productTotals = new Map();
  const brandTotals = new Map();
  const skuPlatformTotals = new Map();
  const productPlatformTotals = new Map();
  const brandPlatformTotals = new Map();
  const addPlatformAmount = (map, key, platform, amount) => {
    const current = map.get(key) || { douyin: 0, pinduoduo: 0, kuaishou: 0, none: 0 };
    current[platform] = (current[platform] || 0) + Number(amount || 0);
    map.set(key, current);
  };
  for (const row of rows) {
    const amount = Number(row.costAmount);
    productTotals.set(row.productId, (productTotals.get(row.productId) || 0) + amount);
    brandTotals.set(row.brandId, (brandTotals.get(row.brandId) || 0) + amount);
  }
  for (const row of platformRows) {
    addPlatformAmount(skuPlatformTotals, row.skuId, row.platform, row.amount);
    addPlatformAmount(productPlatformTotals, row.productId, row.platform, row.amount);
    addPlatformAmount(brandPlatformTotals, row.brandId, row.platform, row.amount);
  }
  const platformText = (amounts) => {
    const source = amounts || { douyin: 0, pinduoduo: 0, kuaishou: 0, none: 0 };
    const lines = [
      ["拼多多", source.pinduoduo || 0],
      ["抖音", source.douyin || 0],
      ["快手", source.kuaishou || 0],
    ];
    if (Number(source.none || 0) !== 0) lines.push(["未选择", source.none || 0]);
    return lines.map(([label, amount]) => `${label}：¥${Number(amount).toFixed(2)}`).join("\n");
  };
  const sheet = addRowsSheet(
    workbook,
    "销售金额",
    ["品牌名", "商品名", "规格名", "销售数量", "成本金额", "规格-平台细分", "商品总金额", "商品-平台细分", "品牌总金额", "品牌-平台细分"],
    rows.map((row) => ({
      values: [
        row.brandName,
        row.productName,
        row.skuName,
        Number(row.salesQty),
        Number(row.costAmount),
        platformText(skuPlatformTotals.get(row.skuId)),
        productTotals.get(row.productId) || 0,
        platformText(productPlatformTotals.get(row.productId)),
        brandTotals.get(row.brandId) || 0,
        platformText(brandPlatformTotals.get(row.brandId)),
      ],
    })),
  );
  for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
    for (const columnNumber of [5, 7, 9]) {
      sheet.getCell(rowNumber, columnNumber).numFmt = '"¥"#,##0.00;-"¥"#,##0.00';
    }
    for (const columnNumber of [6, 8, 10]) {
      sheet.getCell(rowNumber, columnNumber).alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    }
  }
  if (rows.length) {
    mergeSame(sheet, 2, rows.length + 1, [1, 9, 10], (row) => sheet.getCell(row, 1).value);
    mergeSame(sheet, 2, rows.length + 1, [2, 7, 8], (row) => `${sheet.getCell(row, 1).value}-${sheet.getCell(row, 2).value}`);
    for (let rowNumber = 2; rowNumber <= rows.length + 1; rowNumber += 1) {
      for (const columnNumber of [6, 8, 10]) {
        sheet.getCell(rowNumber, columnNumber).alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      }
    }
  }
  autoWidth(sheet);
  sheet.getColumn(6).width = Math.max(sheet.getColumn(6).width || 12, 18);
  sheet.getColumn(8).width = Math.max(sheet.getColumn(8).width || 12, 18);
  sheet.getColumn(10).width = Math.max(sheet.getColumn(10).width || 12, 18);
  return workbook;
}

async function buildExportWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const [catalog, logs] = await Promise.all([
    listCatalog(),
    query(
      `select date_format(l.created_at, '%Y-%m-%d %H:%i:%s') as createdAt,
          l.operation_type as operationType, l.inbound_type as inboundType, l.stock_label as stockLabel,
          case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' when 3 then 'kuaishou' else '' end as platform,
          b.name as brandName, p.name as productName, s.name as skuName, l.quantity, u.name as operatorName, l.remark
       from inventory_operation_logs l
       join users u on u.id = l.operator_user_id
       join skus s on s.id = l.sku_id
       join products p on p.id = s.product_id
       join brands b on b.id = p.brand_id
       where l.created_at >= date_sub(now(), interval 7 day)
       order by l.id desc`,
    ),
  ]);

  const skuSheet = addRowsSheet(
    workbook,
    "SKU管理",
    ["品牌名", "商品名", "规格名", "购入价格", "备注", "是否隐藏", "排序"],
    catalog.map((row) => ({
      values: [
        row.brandName,
        row.productName,
        row.skuName,
        Number(row.purchasePrice),
        row.skuRemark || "",
        row.skuHidden ? "隐藏" : "显示",
        row.skuSort,
      ],
      hidden: row.skuHidden,
    })),
  );
  if (catalog.length) mergeSame(skuSheet, 2, catalog.length + 1, [1, 2], (row, col) => `${col === 1 ? "" : skuSheet.getCell(row, 1).value}-` + skuSheet.getCell(row, col).value);
  addProductInventorySheet(workbook, collectProductInventory(catalog));
  const inventorySheet = addRowsSheet(
    workbook,
    "库存明细",
    ["品牌名", "商品名", "规格名", "库存总量", "可售库存数", "不可售库存数"],
    catalog.map((row) => {
      const salable = Number(row.salableQty);
      return {
        values: [row.brandName, row.productName, row.skuName, salable + Number(row.unsalableQty), salable, Number(row.unsalableQty)],
        fill: salable === 0 ? "FFFFE4E6" : salable === 1 ? "FFFFF7CC" : undefined,
        fillFromColumn: 3,
      };
    }),
  );
  if (catalog.length) mergeSame(inventorySheet, 2, catalog.length + 1, [1, 2], (row, col) => `${col === 1 ? "" : inventorySheet.getCell(row, 1).value}-` + inventorySheet.getCell(row, col).value);
  const logSheet = addRowsSheet(
    workbook,
    "库存操作",
    ["时间", "类型", "品牌名", "商品名", "规格名", "入库类型", "标签", "平台", "数量", "操作人", "备注"],
    logs.map((row) => ({
      values: [
        row.createdAt,
        row.operationType === 1 ? "入库" : "出库",
        row.brandName,
        row.productName,
        row.skuName,
        row.operationType === 1 ? (row.inboundType === 1 ? "新货" : "退货") : "",
        row.stockLabel === 1 ? "可售" : "不可售",
        row.platform === "douyin" ? "抖音" : row.platform === "pinduoduo" ? "拼多多" : row.platform === "kuaishou" ? "快手" : "",
        row.quantity,
        row.operatorName,
        row.remark,
      ],
    })),
  );
  logSheet.eachRow((row, index) => {
    if (index === 1) return;
    const typeCell = row.getCell(2);
    typeCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: typeCell.value === "出库" ? "FFDCFCE7" : "FFFEF9C3" } };
    if (row.getCell(6).value === "退货") row.getCell(6).font = { color: { argb: "FFDC2626" }, bold: true };
    if (row.getCell(7).value === "不可售") row.getCell(7).font = { color: { argb: "FFDC2626" }, bold: true };
  });
  autoWidth(logSheet);
  return workbook;
}

function buildImportSql(workbook) {
  const defaultPasswordHash = bcrypt.hashSync("a000001", 10);
  const lines = ["-- 由导入 Excel 生成，请执行前人工确认。", "-- 导入用户默认密码为 a000001，请上线后及时修改。", "start transaction;"];
  for (const row of sheetRows(workbook, "用户管理")) {
    const permissions = String(row["权限"] || "").split("、").filter(Boolean);
    lines.push(`insert into users(username, email, name, password_hash, status) values(${sqlValue(row["英文用户名"])}, ${sqlValue(row["邮箱"] || "")}, ${sqlValue(row["真实姓名"])}, ${sqlValue(defaultPasswordHash)}, 1) on duplicate key update email = values(email), name = values(name), deleted_at = null;`);
    for (const permission of permissions) {
      lines.push(`insert ignore into user_permissions(user_id, permission_code) select u.id, p.code from users u join permissions p on p.name = ${sqlValue(permission)} where u.username = ${sqlValue(row["英文用户名"])};`);
    }
  }
  for (const row of sheetRows(workbook, "品牌管理")) {
    lines.push(`insert into brands(name, remark, sort_order, is_hidden) values(${sqlValue(row["品牌名"])}, ${sqlValue(row["备注"])}, ${Number(row["排序"] || 0)}, ${row["是否隐藏"] === "隐藏" ? 1 : 0}) on duplicate key update remark = values(remark), sort_order = values(sort_order), is_hidden = values(is_hidden), deleted_at = null;`);
  }
  for (const row of sheetRows(workbook, "商品管理")) {
    lines.push(`insert into products(brand_id, name, remark, sort_order, is_hidden) select b.id, ${sqlValue(row["商品名"])}, ${sqlValue(row["备注"])}, ${Number(row["排序"] || 0)}, ${row["是否隐藏"] === "隐藏" ? 1 : 0} from brands b where b.name = ${sqlValue(row["品牌名"])} on duplicate key update remark = values(remark), sort_order = values(sort_order), is_hidden = values(is_hidden), deleted_at = null;`);
  }
  for (const row of sheetRows(workbook, "SKU管理")) {
    lines.push(`insert into skus(product_id, name, purchase_price, remark, sort_order, is_hidden) select p.id, ${sqlValue(row["规格名"])}, ${Number(row["购入价格"] || 0)}, ${sqlValue(row["备注"])}, ${Number(row["排序"] || 0)}, ${row["是否隐藏"] === "隐藏" ? 1 : 0} from products p join brands b on b.id = p.brand_id where b.name = ${sqlValue(row["品牌名"])} and p.name = ${sqlValue(row["商品名"])} on duplicate key update purchase_price = values(purchase_price), remark = values(remark), sort_order = values(sort_order), is_hidden = values(is_hidden), deleted_at = null;`);
  }
  for (const row of sheetRows(workbook, "库存明细")) {
    lines.push(`insert into sku_inventory(sku_id, salable_qty, unsalable_qty) select s.id, ${Number(row["可售库存数"] || 0)}, ${Number(row["不可售库存数"] || 0)} from skus s join products p on p.id = s.product_id join brands b on b.id = p.brand_id where b.name = ${sqlValue(row["品牌名"])} and p.name = ${sqlValue(row["商品名"])} and s.name = ${sqlValue(row["规格名"])} on duplicate key update salable_qty = values(salable_qty), unsalable_qty = values(unsalable_qty);`);
  }
  for (const row of sheetRows(workbook, "库存操作")) {
    const operationType = row["类型"] === "入库" ? 1 : 2;
    const inboundType = row["入库类型"] === "新货" ? 1 : row["入库类型"] === "退货" ? 2 : "null";
    const stockLabel = row["标签"] === "不可售" ? 2 : 1;
    const platform = row["平台"] === "抖音" ? 1 : row["平台"] === "拼多多" ? 2 : row["平台"] === "快手" ? 3 : "null";
    lines.push(`insert into inventory_operation_logs(sku_id, operation_type, inbound_type, stock_label, platform, quantity, simultaneous_inbound, remark, operator_user_id, created_at) select s.id, ${operationType}, ${inboundType}, ${stockLabel}, ${platform}, ${Number(row["数量"] || 0)}, 0, ${sqlValue(row["备注"])}, u.id, ${sqlValue(row["时间"])} from skus s join products p on p.id = s.product_id join brands b on b.id = p.brand_id join users u on u.name = ${sqlValue(row["操作人"])} where b.name = ${sqlValue(row["品牌名"])} and p.name = ${sqlValue(row["商品名"])} and s.name = ${sqlValue(row["规格名"])};`);
  }
  lines.push("commit;");
  return lines.join("\n");
}

app.get("/api/excel/export", requireAuth, requireSuper, async (_req, res, next) => {
  try {
    const workbook = await buildExportWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=fish-cms-export.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/excel/export/inventory-detail", requireAuth, readScope, async (_req, res, next) => {
  try {
    const workbook = await buildInventoryDetailWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=inventory-detail.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/excel/export/skus", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const workbook = await buildSkuWorkbook(req.query);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=skus.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/excel/export/inventory-amount", requireAuth, readScope, async (_req, res, next) => {
  try {
    const workbook = await buildInventoryAmountWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=inventory-amount.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/excel/export/inventory-logs", requireAuth, readScope, async (req, res, next) => {
  try {
    const workbook = await buildInventoryLogsWorkbook(req.query);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=inventory-logs.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.get("/api/excel/export/sales-amount", requireAuth, readScope, async (req, res, next) => {
  try {
    const workbook = await buildSalesAmountWorkbook(req.query);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=sales-amount.xlsx");
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  }
});

app.post("/api/excel/import", requireAuth, requireSuper, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest("请上传Excel文件");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    res.json({ sql: buildImportSql(workbook) });
  } catch (error) {
    next(error);
  }
});

if (process.env.NODE_ENV === "production") {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(currentDir, "../dist");
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || (error.code === "ER_DUP_ENTRY" ? 409 : 500);
  if (status === 500) console.error(error);
  res.status(status).json({ message: status === 500 ? "服务异常，请稍后再试" : error.message });
});

app.listen(port, () => {
  console.log(`Fish CMS API listening on http://127.0.0.1:${port}`);
});
startMonthlyInventoryAmountEmailJob();
startDailySalesSubscriptionEmailJob();

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
