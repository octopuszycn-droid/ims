from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
import sys

import openpyxl
from openpyxl.utils.datetime import from_excel


SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Users\19162\Desktop\库存台账6.3(1).xlsx")
OUT_SQL = Path("outputs") / f"{SOURCE.stem}_absolute_import.sql"
OUT_REPORT = Path("outputs") / f"{SOURCE.stem}_absolute_import_report.txt"
OUT_FIX = Path("outputs") / f"{SOURCE.stem}_fix_visibility.sql"

INBOUND = "入库"
OUTBOUND = "出库"
NEW_GOODS = "新货"
DOUYIN = "抖音"
PINDUODUO = "拼多多"
HISTORY_BRAND = "流水补录"
BLANK_SKU = "未填规格"
HIDDEN_REMARK = "由流水账补录，库存明细表未列出"
DEFAULT_TIME = "1970-01-01 00:00:00"

DEFAULT_USERS = [
    ("zhangyang", "zhangyang@fish.local", "张洋", "$2a$10$cQNekzQVnJ1t1lppxNS3D.ZpdTPdBg6YCMB6eRLdJqLJZO4JfrHyi"),
    ("zhangyu", "zhangyu@fish.local", "张钰", "$2a$10$AOKfDgN1doGSarh9Sq0//OlAdUflgDuFKyBKkh2K4l3AEyMHIf8I2"),
]


@dataclass
class SkuRow:
    brand: str
    product: str
    sku: str
    price: Decimal
    qty: int
    brand_sort: int
    product_sort: int
    sku_sort: int
    hidden: int = 0
    remark: str = ""


@dataclass
class LogRow:
    source_row: int
    brand: str
    product: str
    sku: str
    created_at: str
    operation_type: int
    inbound_type: str
    stock_label: int
    platform: str
    quantity: int
    remark: str


def norm(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, Decimal) and value == value.to_integral_value():
        return str(int(value))
    return str(value).strip()


def dec(value) -> Decimal:
    text = norm(value)
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def sql_value(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, Decimal):
        return format(money(value), "f")
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"


def sql_datetime(value) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time()).strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, (int, float)) and 30000 <= float(value) <= 60000:
        return from_excel(value).strftime("%Y-%m-%d %H:%M:%S")
    text = norm(value)
    return text or DEFAULT_TIME


def is_subtotal(text: str) -> bool:
    return text.endswith("小计") or text.endswith("总计")


def batch_values(rows: list[str], size: int = 300) -> list[str]:
    return [",\n".join(rows[index:index + size]) for index in range(0, len(rows), size)]


def platform_code(row_values: dict[str, object], remark: str) -> str:
    for key in ("平台", "渠道"):
        value = norm(row_values.get(key))
        if value == DOUYIN:
            return "1"
        if value == PINDUODUO:
            return "2"
    if DOUYIN in remark:
        return "1"
    if PINDUODUO in remark:
        return "2"
    return "null"


def stock_label_code(row_values: dict[str, object], remark: str) -> int:
    for key in ("标签", "库存标签"):
        value = norm(row_values.get(key))
        if "不可售" in value:
            return 2
        if "可售" in value:
            return 1
    if "不可售" in remark:
        return 2
    return 1


def read_summary(summary_ws):
    current_brand = ""
    product_to_brand: dict[str, str] = {}
    summary_products: dict[tuple[str, str], tuple[int, Decimal]] = {}
    brand_sort: dict[str, int] = {}
    product_sort: dict[tuple[str, str], int] = {}

    for row in summary_ws.iter_rows(min_row=3, values_only=True):
        brand = norm(row[0])
        product = norm(row[1])
        if brand:
            current_brand = brand
            brand_sort.setdefault(current_brand, len(brand_sort) + 1)
        if not current_brand or not product or is_subtotal(product):
            continue
        product_to_brand.setdefault(product, current_brand)
        product_sort.setdefault((current_brand, product), len([key for key in product_sort if key[0] == current_brand]) + 1)
        summary_products[(current_brand, product)] = (int(dec(row[3])), money(dec(row[4])))
    return product_to_brand, summary_products, brand_sort, product_sort


def build_excel_sumifs_inventory(log_ws) -> dict[tuple[str, str], int]:
    sums: dict[tuple[str, str], int] = defaultdict(int)
    for row in log_ws.iter_rows(min_row=3, values_only=True):
        product = norm(row[1])
        sku = norm(row[2])
        if not product or not sku:
            continue
        sums[(product.casefold(), sku.casefold())] += int(dec(row[4]))
    return sums


def build_data(source: Path):
    workbook = openpyxl.load_workbook(source, data_only=True)
    formula_workbook = openpyxl.load_workbook(source, data_only=False)
    summary_ws = workbook["库存汇总表"]
    detail_ws = workbook["库存明细表"]
    detail_formula_ws = formula_workbook["库存明细表"]
    log_ws = workbook["流水账"]
    excel_sumifs_inventory = build_excel_sumifs_inventory(log_ws)

    product_to_brand, summary_products, brand_order, product_order = read_summary(summary_ws)
    sku_order: dict[tuple[str, str], int] = defaultdict(int)
    detail_skus: dict[tuple[str, str, str], SkuRow] = {}
    detail_product_totals: dict[tuple[str, str], tuple[int, Decimal]] = defaultdict(lambda: (0, Decimal("0.00")))

    for row_index, row in enumerate(detail_ws.iter_rows(min_row=3, values_only=True), 3):
        if not any(norm(cell) for cell in row[:6]):
            continue
        brand, product, sku = norm(row[0]), norm(row[1]), norm(row[2])
        if not brand or not product or not sku:
            continue
        if is_subtotal(product) or is_subtotal(sku):
            continue
        brand_order.setdefault(brand, len(brand_order) + 1)
        product_order.setdefault((brand, product), len([key for key in product_order if key[0] == brand]) + 1)
        product_to_brand.setdefault(product, brand)
        sku_order[(brand, product)] += 1
        price = dec(row[3])
        qty_formula = norm(detail_formula_ws.cell(row_index, 5).value)
        if qty_formula.upper().startswith("=SUMIFS(") and "流水账" in qty_formula:
            qty = excel_sumifs_inventory.get((product.casefold(), sku.casefold()), 0)
        else:
            qty = int(dec(row[4]))
        amount = money(price * qty)
        key = (brand, product, sku)
        detail_skus[key] = SkuRow(
            brand=brand,
            product=product,
            sku=sku,
            price=price,
            qty=qty,
            brand_sort=brand_order[brand] * 10,
            product_sort=product_order[(brand, product)] * 10,
            sku_sort=sku_order[(brand, product)] * 10,
        )
        total_qty, total_amount = detail_product_totals[(brand, product)]
        detail_product_totals[(brand, product)] = (total_qty + qty, money(total_amount + amount))

    product_sku_to_key: dict[tuple[str, str], tuple[str, str, str]] = {}
    product_case_map = {product.casefold(): product for _, product, _ in detail_skus}
    for key in detail_skus:
        brand, product, sku = key
        product_sku_to_key[(product.casefold(), sku.casefold())] = key

    hidden_skus: dict[tuple[str, str, str], SkuRow] = {}
    logs: list[LogRow] = []
    invalid_rows = []
    date_separator_rows = []
    operation_types = Counter()
    platform_counts = Counter()
    label_counts = Counter()
    hidden_products = Counter()

    def ensure_hidden_sku(product: str, sku: str) -> tuple[str, str, str]:
        canonical_product = product_case_map.get(product.casefold(), product)
        brand = product_to_brand.get(canonical_product, HISTORY_BRAND)
        brand_order.setdefault(brand, len(brand_order) + 1)
        product_order.setdefault((brand, canonical_product), len([key for key in product_order if key[0] == brand]) + 1)
        key = (brand, canonical_product, sku)
        if key in detail_skus or key in hidden_skus:
            return key
        sku_order[(brand, canonical_product)] += 1
        hidden_skus[key] = SkuRow(
            brand=brand,
            product=canonical_product,
            sku=sku,
            price=Decimal("0"),
            qty=0,
            brand_sort=brand_order[brand] * 10,
            product_sort=product_order[(brand, canonical_product)] * 10 + 100000,
            sku_sort=sku_order[(brand, canonical_product)] * 10,
            hidden=1,
            remark=HIDDEN_REMARK,
        )
        hidden_products[(brand, canonical_product)] += 1
        return key

    headers = [norm(cell.value) for cell in log_ws[2]]
    for row_index, row in enumerate(log_ws.iter_rows(min_row=3, values_only=True), 3):
        if not any(norm(cell) for cell in row[:6]):
            continue
        row_values = {header: row[i] if i < len(row) else "" for i, header in enumerate(headers) if header}
        raw_date, raw_product, raw_sku, raw_type, raw_qty, raw_remark = row[:6]
        product = norm(raw_product)
        sku = norm(raw_sku) or BLANK_SKU
        operation_text = norm(raw_type)
        remark = norm(raw_remark)
        qty_decimal = dec(raw_qty)
        quantity = abs(int(qty_decimal))

        if raw_date and not product and not norm(raw_sku) and not operation_text and norm(raw_qty) == "":
            date_separator_rows.append(row_index)
            continue

        if not product or not operation_text or quantity <= 0:
            invalid_rows.append((row_index, product, sku, operation_text, norm(raw_qty)))
            product = product or "未填商品"
            sku = sku or BLANK_SKU
            operation_text = operation_text or INBOUND
            quantity = max(quantity, 1)

        if operation_text == OUTBOUND:
            operation_type = 2
            inbound_type = "null"
        else:
            operation_type = 1
            inbound_type = "1" if NEW_GOODS in remark else "2"

        catalog_key = product_sku_to_key.get((product.casefold(), sku.casefold()))
        if catalog_key is None:
            catalog_key = ensure_hidden_sku(product, sku)

        brand, mapped_product, mapped_sku = catalog_key
        stock_label = stock_label_code(row_values, remark)
        platform = platform_code(row_values, remark)
        operation_types[operation_text] += 1
        platform_counts[platform] += 1
        label_counts[stock_label] += 1
        logs.append(
            LogRow(
                source_row=row_index,
                brand=brand,
                product=mapped_product,
                sku=mapped_sku,
                created_at=sql_datetime(raw_date),
                operation_type=operation_type,
                inbound_type=inbound_type,
                stock_label=stock_label,
                platform=platform,
                quantity=quantity,
                remark=remark,
            )
        )

    return {
        "source": source,
        "summary_products": summary_products,
        "detail_product_totals": dict(detail_product_totals),
        "detail_skus": detail_skus,
        "hidden_skus": hidden_skus,
        "logs": logs,
        "invalid_rows": invalid_rows,
        "date_separator_rows": date_separator_rows,
        "operation_types": operation_types,
        "platform_counts": platform_counts,
        "label_counts": label_counts,
        "hidden_products": hidden_products,
    }


def generate_sql(data) -> str:
    all_skus = {**data["detail_skus"], **data["hidden_skus"]}
    brands: dict[str, tuple[int, int]] = {}
    products: dict[tuple[str, str], tuple[int, int, str]] = {}
    for sku in all_skus.values():
        current_brand = brands.get(sku.brand)
        brands[sku.brand] = (
            sku.brand_sort if current_brand is None else min(current_brand[0], sku.brand_sort),
            1 if sku.brand == HISTORY_BRAND else 0,
        )
        product_key = (sku.brand, sku.product)
        current_product = products.get(product_key)
        products[product_key] = (
            sku.product_sort if current_product is None else min(current_product[0], sku.product_sort),
            max(current_product[1], sku.hidden) if current_product else sku.hidden,
            HIDDEN_REMARK if sku.hidden else "",
        )

    sku_rows = [
        "("
        f"{sql_value(sku.brand)}, {sql_value(sku.product)}, {sql_value(sku.sku)}, "
        f"{sql_value(sku.price)}, {sku.qty}, {sku.brand_sort}, {sku.product_sort}, {sku.sku_sort}, "
        f"{sku.hidden}, {sql_value(sku.remark)}"
        ")"
        for sku in sorted(all_skus.values(), key=lambda item: (item.brand_sort, item.product_sort, item.sku_sort, item.sku))
    ]
    log_rows = [
        "("
        f"{log.source_row}, {sql_value(log.brand)}, {sql_value(log.product)}, {sql_value(log.sku)}, "
        f"{sql_value(log.created_at)}, {log.operation_type}, {log.inbound_type}, {log.stock_label}, "
        f"{log.platform}, {log.quantity}, {sql_value(log.remark)}"
        ")"
        for log in data["logs"]
    ]

    lines = [
        f"-- {data['source'].name} absolute import SQL",
        "-- 库存汇总表/库存明细表是主账；流水账只做日志。",
        "-- 明细表中的当前库存写入 sku_inventory.salable_qty；明细表购入价格写入 skus.purchase_price。",
        "-- 流水中明细表不存在的品牌/商品/SKU 会补建并隐藏，流水不丢失。",
        "set names utf8mb4;",
        "use `fish`;",
        "start transaction;",
        "",
        "alter table `inventory_operation_logs` add column if not exists `platform` tinyint unsigned null comment 'platform: 1 douyin, 2 pinduoduo, null none' after `stock_label`;",
        "",
        "insert into `permissions` (`code`, `name`, `description`) values",
        "  (1, 'SUPER', 'super'),",
        "  (2, 'INVENTORY', 'inventory'),",
        "  (3, 'FINANCE', 'finance')",
        "on duplicate key update `name` = values(`name`), `description` = values(`description`);",
        "",
        "insert into `users` (`username`, `email`, `name`, `password_hash`, `status`) values",
        "  ('zhangyang', 'zhangyang@fish.local', '张洋', '$2a$10$cQNekzQVnJ1t1lppxNS3D.ZpdTPdBg6YCMB6eRLdJqLJZO4JfrHyi', 1),",
        "  ('zhangyu', 'zhangyu@fish.local', '张钰', '$2a$10$AOKfDgN1doGSarh9Sq0//OlAdUflgDuFKyBKkh2K4l3AEyMHIf8I2', 1)",
        "on duplicate key update `name` = values(`name`), `password_hash` = values(`password_hash`), `status` = 1, `deleted_at` = null;",
        "insert into `user_permissions` (`user_id`, `permission_code`)",
        "select u.`id`, 1 from `users` u where binary u.`username` in ('zhangyang', 'zhangyu') and u.`deleted_at` is null",
        "on duplicate key update `permission_code` = values(`permission_code`);",
        "select `id` into @import_operator_id from `users` where binary `username` = 'zhangyang' and `deleted_at` is null limit 1;",
        "",
        "drop temporary table if exists `tmp_import_skus`;",
        "create temporary table `tmp_import_skus` (",
        "  `brand_name` varchar(64) not null,",
        "  `product_name` varchar(64) not null,",
        "  `sku_name` varchar(64) not null,",
        "  `purchase_price` decimal(10,2) not null default 0.00,",
        "  `salable_qty` int not null default 0,",
        "  `brand_sort` int not null default 0,",
        "  `product_sort` int not null default 0,",
        "  `sku_sort` int not null default 0,",
        "  `is_hidden` tinyint unsigned not null default 0,",
        "  `remark` varchar(255) not null default '',",
        "  primary key (`brand_name`, `product_name`, `sku_name`),",
        "  key `idx_tmp_sku_sort` (`brand_sort`, `product_sort`, `sku_sort`)",
        ") engine=InnoDB;",
        "drop temporary table if exists `tmp_import_logs`;",
        "create temporary table `tmp_import_logs` (",
        "  `source_row` int not null,",
        "  `brand_name` varchar(64) not null,",
        "  `product_name` varchar(64) not null,",
        "  `sku_name` varchar(64) not null,",
        "  `created_at` datetime not null,",
        "  `operation_type` tinyint unsigned not null,",
        "  `inbound_type` tinyint unsigned null,",
        "  `stock_label` tinyint unsigned not null,",
        "  `platform` tinyint unsigned null,",
        "  `quantity` int unsigned not null,",
        "  `remark` varchar(255) not null default '',",
        "  key `idx_tmp_logs_catalog` (`brand_name`, `product_name`, `sku_name`),",
        "  key `idx_tmp_logs_source_row` (`source_row`)",
        ") engine=InnoDB;",
        "",
    ]

    for values in batch_values(sku_rows):
        lines.append(
            "insert into `tmp_import_skus` "
            "(`brand_name`, `product_name`, `sku_name`, `purchase_price`, `salable_qty`, `brand_sort`, `product_sort`, `sku_sort`, `is_hidden`, `remark`) values\n"
            f"{values};"
        )
    for values in batch_values(log_rows):
        lines.append(
            "insert into `tmp_import_logs` "
            "(`source_row`, `brand_name`, `product_name`, `sku_name`, `created_at`, `operation_type`, `inbound_type`, `stock_label`, `platform`, `quantity`, `remark`) values\n"
            f"{values};"
        )

    lines.extend([
        "",
        "-- 品牌",
        "insert into `brands` (`name`, `remark`, `sort_order`, `is_hidden`)",
        "select t.`brand_name`, if(t.`is_hidden` = 1, '由流水账补录，库存明细表未列出', ''), t.`brand_sort`, t.`is_hidden`",
        "from (",
        "  select `brand_name`, min(`brand_sort`) as `brand_sort`, min(`is_hidden`) as `is_hidden`",
        "  from `tmp_import_skus` group by `brand_name`",
        ") t",
        "left join `brands` b on binary b.`name` = binary t.`brand_name` and b.`deleted_at` is null",
        "where b.`id` is null;",
        "update `brands` b",
        "join (select `brand_name`, min(`brand_sort`) as `brand_sort`, min(`is_hidden`) as `is_hidden` from `tmp_import_skus` group by `brand_name`) t",
        "  on binary t.`brand_name` = binary b.`name`",
        "set b.`sort_order` = t.`brand_sort`, b.`is_hidden` = t.`is_hidden`,",
        "    b.`remark` = if(t.`is_hidden` = 1 and b.`remark` = '', '由流水账补录，库存明细表未列出', if(t.`is_hidden` = 0 and b.`remark` = '由流水账补录，库存明细表未列出', '', b.`remark`))",
        "where b.`deleted_at` is null;",
        "",
        "-- 商品",
        "insert into `products` (`brand_id`, `name`, `remark`, `sort_order`, `is_hidden`)",
        "select b.`id`, t.`product_name`, if(t.`is_hidden` = 1, '由流水账补录，库存明细表未列出', ''), t.`product_sort`, t.`is_hidden`",
        "from (",
        "  select `brand_name`, `product_name`, min(`product_sort`) as `product_sort`, min(`is_hidden`) as `is_hidden`",
        "  from `tmp_import_skus` group by `brand_name`, `product_name`",
        ") t",
        "join `brands` b on binary b.`name` = binary t.`brand_name` and b.`deleted_at` is null",
        "left join `products` p on p.`brand_id` = b.`id` and binary p.`name` = binary t.`product_name` and p.`deleted_at` is null",
        "where p.`id` is null;",
        "update `products` p",
        "join `brands` b on b.`id` = p.`brand_id` and b.`deleted_at` is null",
        "join (",
        "  select `brand_name`, `product_name`, min(`product_sort`) as `product_sort`, min(`is_hidden`) as `is_hidden`",
        "  from `tmp_import_skus` group by `brand_name`, `product_name`",
        ") t on binary t.`brand_name` = binary b.`name` and binary t.`product_name` = binary p.`name`",
        "set p.`sort_order` = t.`product_sort`, p.`is_hidden` = t.`is_hidden`,",
        "    p.`remark` = if(t.`is_hidden` = 1 and p.`remark` = '', '由流水账补录，库存明细表未列出', if(t.`is_hidden` = 0 and p.`remark` = '由流水账补录，库存明细表未列出', '', p.`remark`))",
        "where p.`deleted_at` is null;",
        "",
        "-- SKU",
        "insert into `skus` (`product_id`, `name`, `purchase_price`, `remark`, `sort_order`, `is_hidden`)",
        "select p.`id`, t.`sku_name`, t.`purchase_price`, t.`remark`, t.`sku_sort`, t.`is_hidden`",
        "from `tmp_import_skus` t",
        "join `brands` b on binary b.`name` = binary t.`brand_name` and b.`deleted_at` is null",
        "join `products` p on p.`brand_id` = b.`id` and binary p.`name` = binary t.`product_name` and p.`deleted_at` is null",
        "left join `skus` s on s.`product_id` = p.`id` and binary s.`name` = binary t.`sku_name` and s.`deleted_at` is null",
        "where s.`id` is null;",
        "update `skus` s",
        "join `products` p on p.`id` = s.`product_id` and p.`deleted_at` is null",
        "join `brands` b on b.`id` = p.`brand_id` and b.`deleted_at` is null",
        "join `tmp_import_skus` t on binary t.`brand_name` = binary b.`name` and binary t.`product_name` = binary p.`name` and binary t.`sku_name` = binary s.`name`",
        "set s.`purchase_price` = t.`purchase_price`, s.`remark` = t.`remark`, s.`sort_order` = t.`sku_sort`, s.`is_hidden` = least(s.`is_hidden`, t.`is_hidden`)",
        "where s.`deleted_at` is null;",
        "",
        "-- 当前库存只按库存明细表/补录 SKU 写入，不按流水加减",
        "insert into `sku_inventory` (`sku_id`, `salable_qty`, `unsalable_qty`)",
        "select s.`id`, t.`salable_qty`, 0",
        "from `tmp_import_skus` t",
        "join `brands` b on binary b.`name` = binary t.`brand_name` and b.`deleted_at` is null",
        "join `products` p on p.`brand_id` = b.`id` and binary p.`name` = binary t.`product_name` and p.`deleted_at` is null",
        "join `skus` s on s.`product_id` = p.`id` and binary s.`name` = binary t.`sku_name` and s.`deleted_at` is null",
        "on duplicate key update `salable_qty` = values(`salable_qty`), `unsalable_qty` = values(`unsalable_qty`);",
        "",
        "-- 流水账全量写入日志，不更新 sku_inventory",
        "insert into `inventory_operation_logs`",
        "(`sku_id`, `operation_type`, `inbound_type`, `stock_label`, `platform`, `quantity`, `simultaneous_inbound`, `remark`, `operator_user_id`, `created_at`)",
        "select s.`id`, l.`operation_type`, l.`inbound_type`, l.`stock_label`, l.`platform`, l.`quantity`, 0, l.`remark`, @import_operator_id, l.`created_at`",
        "from `tmp_import_logs` l",
        "join `brands` b on binary b.`name` = binary l.`brand_name` and b.`deleted_at` is null",
        "join `products` p on p.`brand_id` = b.`id` and binary p.`name` = binary l.`product_name` and p.`deleted_at` is null",
        "join `skus` s on s.`product_id` = p.`id` and binary s.`name` = binary l.`sku_name` and s.`deleted_at` is null",
        "order by l.`source_row`;",
        "",
        "select",
        "  (select count(*) from `tmp_import_skus` where `is_hidden` = 0) as detail_sku_count,",
        "  (select count(*) from `tmp_import_skus` where `is_hidden` = 1) as hidden_sku_count,",
        "  (select sum(`salable_qty`) from `tmp_import_skus` where `is_hidden` = 0) as detail_inventory_qty,",
        "  (select round(sum(`salable_qty` * `purchase_price`), 2) from `tmp_import_skus` where `is_hidden` = 0) as detail_inventory_amount,",
        "  (select count(*) from `tmp_import_logs`) as ledger_log_count;",
        "commit;",
        "",
    ])
    return "\n".join(lines)


def generate_visibility_fix_sql(data) -> str:
    all_skus = {**data["detail_skus"], **data["hidden_skus"]}
    sku_rows = [
        "("
        f"{sql_value(sku.brand)}, {sql_value(sku.product)}, {sql_value(sku.sku)}, "
        f"{sku.brand_sort}, {sku.product_sort}, {sku.sku_sort}, {sku.hidden}, {sql_value(sku.remark)}"
        ")"
        for sku in sorted(all_skus.values(), key=lambda item: (item.brand_sort, item.product_sort, item.sku_sort, item.sku))
    ]

    lines = [
        f"-- {data['source'].name} visibility repair SQL",
        "-- 修复上一版错误：品牌/商品只要存在库存明细，就不应被标记为隐藏。",
        "-- 本脚本不插入流水，不改库存数量，只修复品牌/商品/SKU 的隐藏状态、排序和误写备注。",
        "set names utf8mb4;",
        "use `fish`;",
        "start transaction;",
        "",
        "drop temporary table if exists `tmp_import_visibility`;",
        "create temporary table `tmp_import_visibility` (",
        "  `brand_name` varchar(64) not null,",
        "  `product_name` varchar(64) not null,",
        "  `sku_name` varchar(64) not null,",
        "  `brand_sort` int not null default 0,",
        "  `product_sort` int not null default 0,",
        "  `sku_sort` int not null default 0,",
        "  `is_hidden` tinyint unsigned not null default 0,",
        "  `remark` varchar(255) not null default '',",
        "  primary key (`brand_name`, `product_name`, `sku_name`)",
        ") engine=InnoDB;",
        "",
    ]
    for values in batch_values(sku_rows):
        lines.append(
            "insert into `tmp_import_visibility` "
            "(`brand_name`, `product_name`, `sku_name`, `brand_sort`, `product_sort`, `sku_sort`, `is_hidden`, `remark`) values\n"
            f"{values};"
        )
    lines.extend([
        "",
        "update `brands` b",
        "join (select `brand_name`, min(`brand_sort`) as `brand_sort`, min(`is_hidden`) as `is_hidden` from `tmp_import_visibility` group by `brand_name`) t",
        "  on binary t.`brand_name` = binary b.`name`",
        "set b.`sort_order` = t.`brand_sort`, b.`is_hidden` = t.`is_hidden`,",
        "    b.`remark` = if(t.`is_hidden` = 0 and b.`remark` = '由流水账补录，库存明细表未列出', '', b.`remark`)",
        "where b.`deleted_at` is null;",
        "",
        "update `products` p",
        "join `brands` b on b.`id` = p.`brand_id` and b.`deleted_at` is null",
        "join (select `brand_name`, `product_name`, min(`product_sort`) as `product_sort`, min(`is_hidden`) as `is_hidden` from `tmp_import_visibility` group by `brand_name`, `product_name`) t",
        "  on binary t.`brand_name` = binary b.`name` and binary t.`product_name` = binary p.`name`",
        "set p.`sort_order` = t.`product_sort`, p.`is_hidden` = t.`is_hidden`,",
        "    p.`remark` = if(t.`is_hidden` = 0 and p.`remark` = '由流水账补录，库存明细表未列出', '', p.`remark`)",
        "where p.`deleted_at` is null;",
        "",
        "update `skus` s",
        "join `products` p on p.`id` = s.`product_id` and p.`deleted_at` is null",
        "join `brands` b on b.`id` = p.`brand_id` and b.`deleted_at` is null",
        "join `tmp_import_visibility` t on binary t.`brand_name` = binary b.`name` and binary t.`product_name` = binary p.`name` and binary t.`sku_name` = binary s.`name`",
        "set s.`sort_order` = t.`sku_sort`, s.`is_hidden` = t.`is_hidden`, s.`remark` = t.`remark`",
        "where s.`deleted_at` is null;",
        "",
        "commit;",
        "",
    ])
    return "\n".join(lines)


def write_report(data) -> str:
    detail_qty = sum(row.qty for row in data["detail_skus"].values())
    detail_amount = money(sum((row.price * row.qty for row in data["detail_skus"].values()), Decimal("0")))
    lines = [
        f"source: {data['source']}",
        "rule: summary/detail are master data; ledger rows only create logs; missing ledger catalog is inserted hidden.",
        "inventory_qty_rule: pure-value cells are read directly; SUMIFS formula cells, if any, are recalculated instead of using stale Excel cache.",
        f"summary_products_for_ordering: {len(data['summary_products'])}",
        f"detail_skus: {len(data['detail_skus'])}",
        f"detail_qty: {detail_qty}",
        f"detail_amount_by_qty_price: {detail_amount}",
        f"hidden_skus_created_for_ledger: {len(data['hidden_skus'])}",
        f"ledger_logs: {len(data['logs'])}",
        f"date_separator_rows_skipped: {len(data['date_separator_rows'])}",
        f"operation_types: {dict(data['operation_types'])}",
        f"stock_labels: {dict(data['label_counts'])}",
        f"platforms: {dict(data['platform_counts'])}",
        f"invalid_rows_forced_in: {len(data['invalid_rows'])}",
    ]
    if data["hidden_products"]:
        lines.append("")
        lines.append("hidden catalog created from ledger:")
        for (brand, product), count in data["hidden_products"].most_common(100):
            lines.append(f"{brand} / {product}: {count} sku")
    if data["invalid_rows"]:
        lines.append("")
        lines.append("invalid rows forced into logs:")
        for row in data["invalid_rows"][:50]:
            lines.append(str(row))
    return "\n".join(lines) + "\n"


def main() -> None:
    OUT_SQL.parent.mkdir(exist_ok=True)
    data = build_data(SOURCE)
    OUT_SQL.write_text(generate_sql(data), encoding="utf-8")
    OUT_FIX.write_text(generate_visibility_fix_sql(data), encoding="utf-8")
    OUT_REPORT.write_text(write_report(data), encoding="utf-8")
    print(OUT_SQL.resolve())
    print(OUT_FIX.resolve())
    print(OUT_REPORT.resolve())
    print(write_report(data))


if __name__ == "__main__":
    main()
