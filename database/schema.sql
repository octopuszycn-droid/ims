create database if not exists `fish`
  default character set utf8mb4
  default collate utf8mb4_unicode_ci;

use `fish`;

create table if not exists `permissions` (
  `code` tinyint unsigned not null comment '权限编码：1超级权限，2库存权限，3财务权限',
  `name` varchar(32) not null comment '权限标识：SUPER/INVENTORY/FINANCE',
  `description` varchar(64) not null default '' comment '权限中文说明',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  primary key (`code`),
  unique key `uk_permissions_name` (`name`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='权限字典表';

create table if not exists `users` (
  `id` bigint unsigned not null auto_increment comment '用户ID',
  `email` varchar(128) not null comment '登录邮箱',
  `name` varchar(30) not null comment '用户名/中文姓名',
  `password_hash` varchar(255) not null comment 'bcrypt密码哈希',
  `status` tinyint unsigned not null default 1 comment '状态：0停用，1启用',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  `updated_at` datetime not null default current_timestamp on update current_timestamp comment '更新时间',
  `deleted_at` datetime null comment '软删除时间',
  primary key (`id`),
  unique key `uk_users_email` (`email`),
  key `idx_users_status` (`status`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='用户表';

create table if not exists `user_permissions` (
  `user_id` bigint unsigned not null comment '用户ID',
  `permission_code` tinyint unsigned not null comment '权限编码',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  primary key (`user_id`, `permission_code`),
  constraint `fk_user_permissions_user` foreign key (`user_id`) references `users` (`id`) on delete cascade,
  constraint `fk_user_permissions_permission` foreign key (`permission_code`) references `permissions` (`code`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='用户权限绑定表';

create table if not exists `brands` (
  `id` bigint unsigned not null auto_increment comment '品牌ID',
  `name` varchar(30) not null comment '品牌名，最多15个汉字',
  `remark` varchar(255) not null default '' comment '备注',
  `default_platform` tinyint unsigned null comment '默认平台：1抖音，2拼多多，为空表示未选择',
  `sort_order` int not null default 0 comment '排序值，升序',
  `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  `updated_at` datetime not null default current_timestamp on update current_timestamp comment '更新时间',
  `deleted_at` datetime null comment '软删除时间',
  primary key (`id`),
  unique key `uk_brands_name_deleted` (`name`, `deleted_at`),
  key `idx_brands_sort` (`is_hidden`, `sort_order`, `id`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='品牌表';

create table if not exists `products` (
  `id` bigint unsigned not null auto_increment comment '商品ID',
  `brand_id` bigint unsigned not null comment '品牌ID',
  `name` varchar(30) not null comment '商品名，最多15个汉字',
  `remark` varchar(255) not null default '' comment '备注',
  `sort_order` int not null default 0 comment '品牌内排序值，升序',
  `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  `updated_at` datetime not null default current_timestamp on update current_timestamp comment '更新时间',
  `deleted_at` datetime null comment '软删除时间',
  primary key (`id`),
  unique key `uk_products_brand_name_deleted` (`brand_id`, `name`, `deleted_at`),
  key `idx_products_brand_sort` (`brand_id`, `is_hidden`, `sort_order`, `id`),
  constraint `fk_products_brand` foreign key (`brand_id`) references `brands` (`id`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='商品表';

create table if not exists `skus` (
  `id` bigint unsigned not null auto_increment comment 'SKU ID',
  `product_id` bigint unsigned not null comment '商品ID',
  `name` varchar(30) not null comment '规格名，最多15个汉字',
  `purchase_price` decimal(10,2) not null default 0.00 comment '购入价格',
  `remark` varchar(255) not null default '' comment '备注',
  `sort_order` int not null default 0 comment '商品内排序值，升序',
  `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  `updated_at` datetime not null default current_timestamp on update current_timestamp comment '更新时间',
  `deleted_at` datetime null comment '软删除时间',
  primary key (`id`),
  unique key `uk_skus_product_name_deleted` (`product_id`, `name`, `deleted_at`),
  key `idx_skus_product_sort` (`product_id`, `is_hidden`, `sort_order`, `id`),
  constraint `fk_skus_product` foreign key (`product_id`) references `products` (`id`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='SKU规格表';

create table if not exists `sku_inventory` (
  `sku_id` bigint unsigned not null comment 'SKU ID',
  `salable_qty` int not null default 0 comment '可售库存数',
  `unsalable_qty` int not null default 0 comment '不可售库存数',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  `updated_at` datetime not null default current_timestamp on update current_timestamp comment '更新时间',
  primary key (`sku_id`),
  constraint `fk_sku_inventory_sku` foreign key (`sku_id`) references `skus` (`id`) on delete cascade
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='SKU库存表';

create table if not exists `inventory_operation_logs` (
  `id` bigint unsigned not null auto_increment comment '库存操作日志ID',
  `sku_id` bigint unsigned not null comment 'SKU ID',
  `operation_type` tinyint unsigned not null comment '操作类型：1入库，2出库',
  `inbound_type` tinyint unsigned null comment '入库类型：1新货，2退货；出库为空',
  `stock_label` tinyint unsigned not null comment '库存标签：1可售库存，2不可售库存',
  `platform` tinyint unsigned null comment '平台：1抖音，2拼多多，为空表示未选择',
  `quantity` int unsigned not null comment '操作数量',
  `simultaneous_inbound` tinyint unsigned not null default 0 comment '不可售出库时是否同时转入可售：0否，1是',
  `remark` varchar(255) not null default '' comment '备注',
  `operator_user_id` bigint unsigned not null comment '操作人用户ID',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  primary key (`id`),
  key `idx_inventory_logs_sku_time` (`sku_id`, `created_at`),
  key `idx_inventory_logs_operator_time` (`operator_user_id`, `created_at`),
  constraint `fk_inventory_logs_sku` foreign key (`sku_id`) references `skus` (`id`),
  constraint `fk_inventory_logs_operator` foreign key (`operator_user_id`) references `users` (`id`),
  constraint `chk_inventory_logs_operation_type` check (`operation_type` in (1, 2)),
  constraint `chk_inventory_logs_inbound_type` check (`inbound_type` is null or `inbound_type` in (1, 2)),
  constraint `chk_inventory_logs_stock_label` check (`stock_label` in (1, 2)),
  constraint `chk_inventory_logs_platform` check (`platform` is null or `platform` in (1, 2)),
  constraint `chk_inventory_logs_quantity` check (`quantity` > 0),
  constraint `chk_inventory_logs_simultaneous` check (`simultaneous_inbound` in (0, 1))
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存操作日志表';

create table if not exists `inventory_checks` (
  `id` bigint unsigned not null auto_increment comment '盘点记录ID',
  `check_time` datetime not null default current_timestamp comment '盘点时间',
  `operator_user_id` bigint unsigned not null comment '盘点上传人用户ID',
  `upload_file_path` varchar(255) not null default '' comment '盘点上传原始文件相对路径',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  primary key (`id`),
  key `idx_inventory_checks_time` (`check_time`, `id`),
  key `idx_inventory_checks_operator` (`operator_user_id`),
  constraint `fk_inventory_checks_operator` foreign key (`operator_user_id`) references `users` (`id`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存盘点记录表';

create table if not exists `inventory_check_differences` (
  `id` bigint unsigned not null auto_increment comment '盘点差异明细ID',
  `check_id` bigint unsigned not null comment '盘点记录ID',
  `sku_id` bigint unsigned not null comment 'SKU ID',
  `brand_name` varchar(64) not null comment '盘点时品牌名快照',
  `product_name` varchar(64) not null comment '盘点时商品名快照',
  `sku_name` varchar(64) not null comment '盘点时规格名快照',
  `system_salable_qty` int not null comment '系统可售库存数',
  `system_unsalable_qty` int not null comment '系统不可售库存数',
  `actual_salable_qty` int not null comment '实际可售库存数',
  `actual_unsalable_qty` int not null comment '实际不可售库存数',
  `salable_diff_qty` int not null comment '可售库存数差值：实际-系统',
  `unsalable_diff_qty` int not null comment '不可售库存数差值：实际-系统',
  `created_at` datetime not null default current_timestamp comment '创建时间',
  primary key (`id`),
  key `idx_inventory_check_diff_check` (`check_id`, `id`),
  key `idx_inventory_check_diff_sku` (`sku_id`),
  constraint `fk_inventory_check_diff_check` foreign key (`check_id`) references `inventory_checks` (`id`) on delete cascade,
  constraint `fk_inventory_check_diff_sku` foreign key (`sku_id`) references `skus` (`id`)
) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci comment='库存盘点差异明细表';

insert into `permissions` (`code`, `name`, `description`) values
  (1, 'SUPER', '超级权限'),
  (2, 'INVENTORY', '库存权限'),
  (3, 'FINANCE', '财务权限')
on duplicate key update
  `name` = values(`name`),
  `description` = values(`description`);

alter table `users` add column if not exists `username` varchar(64) null comment '英文登录用户名' after `id`;
update `users` set `username` = substring_index(`email`, '@', 1) where `username` is null or `username` = '';
alter table `users` modify column `username` varchar(64) not null comment '英文登录用户名';
create unique index if not exists `uk_users_username` on `users` (`username`);

alter table `brands` add column if not exists `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after `sort_order`;
alter table `brands` add column if not exists `default_platform` tinyint unsigned null comment '默认平台：1抖音，2拼多多，为空表示未选择' after `remark`;
alter table `products` add column if not exists `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after `sort_order`;
alter table `skus` add column if not exists `is_hidden` tinyint unsigned not null default 0 comment '是否隐藏：0否，1是' after `sort_order`;
alter table `sku_inventory` drop constraint if exists `chk_sku_inventory_qty`;
alter table `sku_inventory` modify column `salable_qty` int not null default 0 comment '可售库存数';
alter table `sku_inventory` modify column `unsalable_qty` int not null default 0 comment '不可售库存数';
alter table `inventory_operation_logs` add column if not exists `platform` tinyint unsigned null comment '平台：1抖音，2拼多多，为空表示未选择' after `stock_label`;
alter table `inventory_checks` add column if not exists `upload_file_path` varchar(255) not null default '' comment '盘点上传原始文件相对路径' after `operator_user_id`;
