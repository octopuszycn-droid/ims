import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runSchema() {
  const schemaPath = join(__dirname, "..", "database", "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }

  await pool.query("alter table users add column if not exists username varchar(64) null comment '英文登录用户名' after id");
  await pool.query("update users set username = substring_index(email, '@', 1) where username is null or username = ''");
  await pool.query("alter table users modify column username varchar(64) not null comment '英文登录用户名'");
  await pool.query("create unique index if not exists uk_users_username on users(username)");
}

const permissions = [
  [1, "SUPER", "超级权限"],
  [2, "INVENTORY", "库存权限"],
  [3, "FINANCE", "财务权限"],
];

const users = [
  ["zhangyang", "张洋", "a000001", [1]],
  ["zhangyu", "张钰", "a000002", [1]],
];

const brands = [
  ["光威", "主销综合品牌", 10],
  ["达瓦", "中高端系列", 20],
  ["禧玛诺", "进口系列", 30],
];

const products = [
  [1, "龙云二代", "台钓竿", 10],
  [1, "无法一本", "综合竿", 20],
  [2, "一击", "轻量硬挺", 10],
  [2, "波纹龙", "经典款", 20],
  [3, "景仙", "长尺寸", 10],
];

const skus = [
  [1, "3.6米", 168, "短尺寸", 10, 7, 1],
  [1, "4.5米", 198, "", 20, 12, 0],
  [1, "5.4米", 238, "", 30, 1, 2],
  [2, "4.5米", 128, "", 10, 0, 1],
  [2, "5.4米", 158, "", 20, 6, 0],
  [3, "3.9米", 286, "热销", 10, 4, 0],
  [3, "4.8米", 336, "", 20, 9, 1],
  [4, "5.4米", 428, "", 10, 3, 0],
  [5, "6.3米", 528, "长竿", 10, 2, 1],
];

await runSchema();

await withTransaction(async (connection) => {
  for (const permission of permissions) {
    await connection.execute(
      `insert into permissions(code, name, description)
       values(?, ?, ?)
       on duplicate key update name = values(name), description = values(description)`,
      permission,
    );
  }

  for (const [username, name, password, permissionCodes] of users) {
    const passwordHash = await bcrypt.hash(password, 10);
    await connection.execute(
      `insert into users(username, email, name, password_hash, status)
       values(?, ?, ?, ?, 1)
       on duplicate key update name = values(name), password_hash = values(password_hash), status = 1, deleted_at = null`,
      [username, `${username}@fish.local`, name, passwordHash],
    );
    const [[row]] = await connection.query("select id from users where username = ?", [username]);
    await connection.execute("delete from user_permissions where user_id = ?", [row.id]);
    for (const code of permissionCodes) {
      await connection.execute("insert into user_permissions(user_id, permission_code) values(?, ?)", [row.id, code]);
    }
  }

  const [[brandCount]] = await connection.query("select count(*) as count from brands");
  if (brandCount.count === 0) {
    for (const brand of brands) {
      await connection.execute("insert into brands(name, remark, sort_order) values(?, ?, ?)", brand);
    }
    for (const product of products) {
      await connection.execute("insert into products(brand_id, name, remark, sort_order) values(?, ?, ?, ?)", product);
    }
    for (const [productId, name, price, remark, sort, salable, unsalable] of skus) {
      const [created] = await connection.execute(
        "insert into skus(product_id, name, purchase_price, remark, sort_order) values(?, ?, ?, ?, ?)",
        [productId, name, price, remark, sort],
      );
      await connection.execute("insert into sku_inventory(sku_id, salable_qty, unsalable_qty) values(?, ?, ?)", [
        created.insertId,
        salable,
        unsalable,
      ]);
    }
  }
});

await pool.end();
console.log("Seed data has been written.");
