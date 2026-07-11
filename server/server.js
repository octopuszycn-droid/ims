import bcrypt from "bcryptjs";
import cors from "cors";
import dotenv from "dotenv";
import ExcelJS from "exceljs";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, withTransaction } from "./db.js";

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 3001);
const jwtSecret = process.env.JWT_SECRET || "change-this-secret-before-production";
const tokenTtlSeconds = 7 * 24 * 60 * 60;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const permissionCodeByName = { SUPER: 1, INVENTORY: 2, FINANCE: 3 };
const permissionNameByCode = { 1: "SUPER", 2: "INVENTORY", 3: "FINANCE" };

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://127.0.0.1:5173" }));
app.use(express.json({ limit: "1mb" }));

await ensureSchema();

async function ensureSchema() {
  await query("alter table brands add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table brands add column if not exists default_platform tinyint unsigned null comment '默认平台：1抖音，2拼多多，为空表示未选择' after remark");
  await query("alter table products add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table skus add column if not exists is_hidden tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after sort_order");
  await query("alter table inventory_operation_logs add column if not exists platform tinyint unsigned null comment '平台：1抖音，2拼多多，为空表示未选择' after stock_label");
  await query(`create table if not exists inventory_checks (
    id bigint unsigned not null auto_increment comment '盘点记录ID',
    check_time datetime not null default current_timestamp comment '盘点时间',
    operator_user_id bigint unsigned not null comment '盘点上传人用户ID',
    created_at datetime not null default current_timestamp comment '创建时间',
    primary key (id),
    key idx_inventory_checks_time (check_time, id),
    key idx_inventory_checks_operator (operator_user_id),
    constraint fk_inventory_checks_operator foreign key (operator_user_id) references users (id)
  ) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存盘点记录表'`);
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
  try {
    await query("alter table sku_inventory drop constraint chk_sku_inventory_qty");
  } catch (error) {
    if (!["ER_CANT_DROP_FIELD_OR_KEY", "ER_CHECK_CONSTRAINT_NOT_FOUND"].includes(error.code)) throw error;
  }
  await query("alter table sku_inventory modify column salable_qty int not null default 0 comment '可售库存数'");
  await query("alter table sku_inventory modify column unsalable_qty int not null default 0 comment '不可售库存数'");
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

function normalizePermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) throw badRequest("至少绑定一个权限");
  const codes = [...new Set(permissions.map((item) => permissionCodeByName[item]).filter(Boolean))];
  if (codes.length !== new Set(permissions).size) throw badRequest("权限参数不合法");
  return codes;
}

function normalizePlatform(value) {
  if (value === "douyin") return 1;
  if (value === "pinduoduo") return 2;
  return null;
}

async function getUserPermissions(userId) {
  const rows = await query("select permission_code from user_permissions where user_id = ?", [userId]);
  return rows.map((row) => permissionNameByCode[row.permission_code]).filter(Boolean);
}

async function findUserById(userId) {
  const rows = await query(
    "select id, username, name, status, created_at, updated_at from users where id = ? and deleted_at is null",
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

async function listCatalog() {
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
     where b.deleted_at is null
     order by b.is_hidden, b.sort_order, b.id, p.is_hidden, p.sort_order, p.id, s.is_hidden, s.sort_order, s.id`,
  );
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const username = assertUsername(req.body.username);
    const password = String(req.body.password || "");
    const rows = await query(
      "select id, username, name, password_hash, status from users where username = ? and deleted_at is null",
      [username],
    );
    const user = rows[0];
    if (!user || user.status !== 1) return res.status(401).json({ message: "用户名或密码错误" });
    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "用户名或密码错误" });
    }
    const permissions = await getUserPermissions(user.id);
    res.json({ user: { id: user.id, username: user.username, name: user.name, status: user.status, permissions }, permissions, ...signToken(user, permissions) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireAuth, (_req, res) => res.json({ ok: true }));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.user, permissions: req.user.permissions }));

app.get("/api/users", requireAuth, requireSuper, async (_req, res, next) => {
  try {
    const rows = await query(
      `select u.id, u.username, u.name, u.status, u.created_at as createdAt,
        group_concat(up.permission_code order by up.permission_code) as permissionCodes
       from users u
       left join user_permissions up on up.user_id = u.id
       where u.deleted_at is null
       group by u.id, u.username, u.name, u.status, u.created_at
       order by u.id`,
    );
    res.json(rows.map((row) => ({ ...row, permissions: String(row.permissionCodes || "").split(",").filter(Boolean).map((code) => permissionNameByCode[code]) })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", requireAuth, requireSuper, async (req, res, next) => {
  try {
    const username = assertUsername(req.body.username);
    const name = assertName(req.body.name, "真实姓名");
    const password = String(req.body.password || "");
    assertPassword(password);
    const permissionCodes = normalizePermissions(req.body.permissions);
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = await withTransaction(async (connection) => {
      const [created] = await connection.execute(
        "insert into users(username, email, name, password_hash, status) values(?, ?, ?, ?, 1)",
        [username, `${username}@fish.local`, name, passwordHash],
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
    const status = req.body.status === 0 ? 0 : 1;
    const permissionCodes = normalizePermissions(req.body.permissions);
    const password = String(req.body.password || "");
    if (password) assertPassword(password);
    await withTransaction(async (connection) => {
      if (password) {
        await connection.execute(
          "update users set username = ?, email = ?, name = ?, password_hash = ?, status = ? where id = ?",
          [username, `${username}@fish.local`, name, await bcrypt.hash(password, 10), status, userId],
        );
      } else {
        await connection.execute("update users set username = ?, email = ?, name = ?, status = ? where id = ?", [
          username,
          `${username}@fish.local`,
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
          case default_platform when 1 then 'douyin' when 2 then 'pinduoduo' else '' end as defaultPlatform,
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

async function writeInventoryOperation(req, mode) {
  const skuId = Number(req.body.skuId);
  const quantity = toPositiveInteger(req.body.quantity, "数量");
  const label = req.body.label === "unsalable" ? "unsalable" : "salable";
  const labelCode = label === "salable" ? 1 : 2;
  const inboundType = req.body.inboundType === "new" ? 1 : 2;
  const platform = normalizePlatform(req.body.platform);
  const simultaneousInbound = Boolean(req.body.simultaneousInbound);
  const operationType = mode === "in" ? 1 : 2;
  return withTransaction(async (connection) => {
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
        (sku_id, operation_type, inbound_type, stock_label, platform, quantity, simultaneous_inbound, remark, operator_user_id)
       values(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [skuId, operationType, mode === "in" ? inboundType : null, labelCode, platform, quantity, mode === "out" && label === "unsalable" && simultaneousInbound ? 1 : 0, String(req.body.remark || "").trim(), req.user.id],
    );
    return { id: created.insertId, salableQty: salable, unsalableQty: unsalable };
  });
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
       join skus s on s.id = l.sku_id
       join products p on p.id = s.product_id
       join brands b on b.id = p.brand_id
       ${whereSql}`;
  const [totalRow] = await query(`select count(*) as total ${fromSql}`, params);
  const limitSql = paging.limit ? " limit ? offset ?" : "";
  const limitParams = paging.limit ? [paging.limit, paging.offset || 0] : [];
  const rows = await query(
    `select l.id, l.operation_type as operationType, l.inbound_type as inboundType,
        l.stock_label as stockLabel, l.quantity, l.simultaneous_inbound as simultaneousInbound,
        case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' else '' end as platform,
        l.remark, date_format(l.created_at, '%Y-%m-%d %H:%i:%s') as createdAt, u.name as operatorName,
        b.name as brandName, p.name as productName, s.name as skuName
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

app.get("/api/inventory/checks", requireAuth, readScope, async (_req, res, next) => {
  try {
    res.json(await query(
      `select c.id, date_format(c.check_time, '%Y-%m-%d %H:%i:%s') as checkTime,
          u.name as operatorName, count(d.id) as differenceCount
       from inventory_checks c
       join users u on u.id = c.operator_user_id
       left join inventory_check_differences d on d.check_id = c.id
       group by c.id, c.check_time, u.name
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
    res.status(201).json(await importInventoryCheckWorkbook(req.file.buffer, req.user.id));
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

app.get("/api/stats/sales/amount", requireAuth, readScope, async (req, res, next) => {
  try {
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.startDate || "")) ? String(req.query.startDate) : dateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.endDate || "")) ? String(req.query.endDate) : dateKey(new Date());
    res.json(
      await query(
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
      ),
    );
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
      values: [row.brandName, row.productName, row.skuName, "", ""],
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
  if (value === null || value === undefined || value === "") throw badRequest(`第${rowNumber}行${label}不能为空`);
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue)) throw badRequest(`第${rowNumber}行${label}必须是整数`);
  return numberValue;
}

async function buildInventoryCheckTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  addInventoryCheckTemplateSheet(workbook, await listCatalog());
  return workbook;
}

async function getInventoryCheckRecord(checkId) {
  const rows = await query(
    `select c.id, date_format(c.check_time, '%Y-%m-%d %H:%i:%s') as checkTime,
        u.name as operatorName, count(d.id) as differenceCount
     from inventory_checks c
     join users u on u.id = c.operator_user_id
     left join inventory_check_differences d on d.check_id = c.id
     where c.id = ?
     group by c.id, c.check_time, u.name`,
    [checkId],
  );
  return rows[0] || null;
}

async function listInventoryCheckDifferences(checkId) {
  return query(
    `select id, check_id as checkId, sku_id as skuId,
        brand_name as brandName, product_name as productName, sku_name as skuName,
        system_salable_qty as systemSalableQty,
        system_unsalable_qty as systemUnsalableQty,
        actual_salable_qty as actualSalableQty,
        actual_unsalable_qty as actualUnsalableQty,
        salable_diff_qty as salableDiffQty,
        unsalable_diff_qty as unsalableDiffQty
     from inventory_check_differences
     where check_id = ?
     order by id`,
    [checkId],
  );
}

async function importInventoryCheckWorkbook(buffer, operatorUserId) {
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
      });
    }
  }

  const checkId = await withTransaction(async (connection) => {
    const [created] = await connection.execute(
      "insert into inventory_checks(operator_user_id) values(?)",
      [operatorUserId],
    );
    for (const item of differences) {
      await connection.execute(
        `insert into inventory_check_differences
          (check_id, sku_id, brand_name, product_name, sku_name,
           system_salable_qty, system_unsalable_qty, actual_salable_qty, actual_unsalable_qty,
           salable_diff_qty, unsalable_diff_qty)
         values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.platform === "douyin" ? "抖音" : row.platform === "pinduoduo" ? "拼多多" : "",
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
  addInventoryDetailSheet(workbook, await listCatalog());
  return workbook;
}

async function buildInventoryLogsWorkbook(filters) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "fish-cms";
  const { rows } = await queryInventoryLogs(filters);
  addInventoryLogsSheet(workbook, rows);
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
          case l.platform when 1 then 'douyin' when 2 then 'pinduoduo' else '' end as platform,
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
        row.platform === "douyin" ? "抖音" : row.platform === "pinduoduo" ? "拼多多" : "",
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
    lines.push(`insert into users(username, email, name, password_hash, status) values(${sqlValue(row["英文用户名"])}, concat(${sqlValue(row["英文用户名"])}, '@fish.local'), ${sqlValue(row["真实姓名"])}, ${sqlValue(defaultPasswordHash)}, 1) on duplicate key update name = values(name), deleted_at = null;`);
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
    const platform = row["平台"] === "抖音" ? 1 : row["平台"] === "拼多多" ? 2 : "null";
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

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
