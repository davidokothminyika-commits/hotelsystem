-- ============================================================================
--  HOTEL MANAGEMENT SYSTEM - DATABASE SCHEMA
-- ============================================================================
--  Engine   : InnoDB (transactions + foreign keys)
--  Charset  : utf8mb4 / utf8mb4_unicode_ci
--
--  DESIGN RULES APPLIED THROUGHOUT
--   1. Every table has a surrogate PRIMARY KEY (id).
--   2. Foreign keys are declared so the database prevents orphans, with
--      ON DELETE behaviour chosen per relationship:
--        - CASCADE  : child rows have no meaning without the parent
--                    (order_items when an order is deleted).
--        - RESTRICT : deleting the parent would destroy business history
--                    (you cannot delete a user who has bookings).
--        - SET NULL : the link is optional (a cancelled booking's room link
--                    is kept for reporting, but a deleted bonus becomes NULL).
--   3. Columns used for filtering get indexes; columns used for sorting inside
--      a filter get composite indexes with the filter column first.
--   4. Money is stored as DECIMAL, never FLOAT. DECIMAL is exact base-10 so
--      0.1 + 0.2 == 0.30 instead of drifting.
--   5. ENUMs are used for closed, stable state machines (booking status, order
--      status, payment status) because MySQL validates them and they save space.
--      Lookup tables are used where values are user-managed (roles, room types,
--      amenities, menu categories).
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================================
--  SECTION 1 - IDENTITY, ACCESS CONTROL AND AUDIT
-- ============================================================================

-- ---------------------------------------------------------------------------
-- roles
-- Lookup table for the six system roles rather than an ENUM on users, so
-- roles can be renamed or extended without altering the users table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
    id          TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(50)     NOT NULL,
    description VARCHAR(255)    NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_roles_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- permissions
-- Fine grained capabilities such as 'booking:update'. Roles map to these via
-- role_permissions, which keeps authorization declarative and auditable
-- instead of scattering role name checks across middleware.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
    id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code        VARCHAR(80)     NOT NULL COMMENT 'e.g. booking:update',
    description VARCHAR(255)    NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_permissions_code (code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       TINYINT UNSIGNED     NOT NULL,
    permission_id SMALLINT UNSIGNED    NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    KEY ix_role_permissions_permission (permission_id),
    CONSTRAINT fk_role_permissions_role
        FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    CONSTRAINT fk_role_permissions_permission
        FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- users
-- One row per person who can log in: guests and staff alike.
-- profile_image stores a generated filename only; the original client
-- filename is never trusted (see src/middleware/upload.middleware.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    role_id           TINYINT UNSIGNED NOT NULL,
    first_name        VARCHAR(80)     NOT NULL,
    last_name         VARCHAR(80)     NOT NULL,
    email             VARCHAR(190)    NOT NULL,
    phone             VARCHAR(30)     NULL,
    password_hash     VARCHAR(255)    NOT NULL COMMENT 'bcrypt hash, never plaintext',
    profile_image     VARCHAR(255)    NULL,
    is_active         TINYINT(1)      NOT NULL DEFAULT 1,
    email_verified    TINYINT(1)      NOT NULL DEFAULT 0,
    email_verified_at DATETIME        NULL,
    last_login_at     DATETIME        NULL,
    created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- Case insensitive uniqueness: Guest@x.com and guest@x.com are one account.
    UNIQUE KEY uq_users_email (email),
    KEY ix_users_role (role_id),
    KEY ix_users_active (is_active),
    KEY ix_users_created (created_at),
    CONSTRAINT fk_users_role
        FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- password_resets
-- Stores ONLY the SHA-256 hash of the reset token. The raw token exists
-- solely in the emailed link, so a database leak cannot be replayed.
-- used_at lets every issued token be single use.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64)        NOT NULL COMMENT 'sha256 hex of the raw token',
    expires_at DATETIME        NOT NULL,
    used_at    DATETIME        NULL COMMENT 'set once the password is changed',
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_password_resets_token_hash (token_hash),
    KEY ix_password_resets_user (user_id),
    KEY ix_password_resets_expires (expires_at),
    CONSTRAINT fk_password_resets_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- email_verification_tokens
-- Same security model as password_resets: hash only, single use, expiring.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64)        NOT NULL,
    expires_at DATETIME        NOT NULL,
    used_at    DATETIME        NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_email_verification_tokens_hash (token_hash),
    KEY ix_email_verification_tokens_user (user_id),
    CONSTRAINT fk_email_verification_tokens_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- audit_logs
-- Append only record of security relevant actions. metadata holds a JSON
-- string so new attributes never require a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    BIGINT UNSIGNED NULL COMMENT 'null for failed logins',
    action     VARCHAR(80)     NOT NULL COMMENT 'e.g. booking.created',
    entity     VARCHAR(60)     NULL COMMENT 'table or resource name',
    entity_id  VARCHAR(64)     NULL,
    ip_address VARCHAR(45)     NULL COMMENT '45 chars fits IPv6',
    user_agent VARCHAR(255)    NULL,
    metadata   JSON            NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_audit_logs_user (user_id),
    KEY ix_audit_logs_action (action),
    KEY ix_audit_logs_entity (entity, entity_id),
    KEY ix_audit_logs_created (created_at),
    CONSTRAINT fk_audit_logs_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 2 - HOTEL INVENTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS room_types (
    id               SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name             VARCHAR(60)        NOT NULL,
    slug             VARCHAR(60)        NOT NULL COMMENT 'URL friendly key',
    description      TEXT               NULL,
    base_price       DECIMAL(10, 2)     NOT NULL DEFAULT 0.00,
    max_capacity     TINYINT UNSIGNED   NOT NULL DEFAULT 2,
    size_sqm         SMALLINT UNSIGNED  NULL,
    bed_configuration VARCHAR(120)      NULL,
    image            VARCHAR(255)       NULL,
    is_active        TINYINT(1)         NOT NULL DEFAULT 1,
    created_at       TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_room_types_slug (slug),
    UNIQUE KEY uq_room_types_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- rooms
-- status is operational state (available/occupied/reserved/maintenance/
-- cleaning) managed by reception and housekeeping. It is separate from
-- booking_status because a room can be "clean" yet unbooked for three days.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id               INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    room_number      VARCHAR(10)      NOT NULL,
    room_type_id     SMALLINT UNSIGNED NOT NULL,
    floor            TINYINT UNSIGNED NOT NULL DEFAULT 1,
    capacity         TINYINT UNSIGNED NOT NULL DEFAULT 2,
    price_per_night  DECIMAL(10, 2)   NOT NULL,
    description      TEXT             NULL,
    status           ENUM('available', 'occupied', 'reserved', 'maintenance', 'cleaning')
                         NOT NULL DEFAULT 'available',
    image            VARCHAR(255)     NULL,
    is_active        TINYINT(1)       NOT NULL DEFAULT 1 COMMENT 'set to 0 to retire a room',
    created_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_rooms_number (room_number),
    KEY ix_rooms_type (room_type_id),
    KEY ix_rooms_status (status),
    KEY ix_rooms_price (price_per_night),
    -- Availability search filters by status then price, so this composite
    -- index lets the query avoid a filesort on large room counts.
    KEY ix_rooms_status_price (status, price_per_night),
    KEY ix_rooms_floor (floor),
    CONSTRAINT fk_rooms_type
        FOREIGN KEY (room_type_id) REFERENCES room_types (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Many-to-many room <-> amenity, resolved by room_amenities.
CREATE TABLE IF NOT EXISTS amenities (
    id          SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(60)        NOT NULL,
    icon        VARCHAR(60)        NULL COMMENT 'icon identifier, not an emoji',
    description VARCHAR(255)       NULL,
    created_at  TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_amenities_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS room_amenities (
    room_id    INT UNSIGNED      NOT NULL,
    amenity_id SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (room_id, amenity_id),
    KEY ix_room_amenities_amenity (amenity_id),
    CONSTRAINT fk_room_amenities_room
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
    CONSTRAINT fk_room_amenities_amenity
        FOREIGN KEY (amenity_id) REFERENCES amenities (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 3 - BOOKINGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS bookings (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Human readable reference shown on invoices and confirmations.
    booking_reference CHAR(12)        NOT NULL,
    user_id           BIGINT UNSIGNED NOT NULL,
    room_id           INT UNSIGNED    NOT NULL,
    check_in          DATE            NOT NULL,
    check_out         DATE            NOT NULL,
    guests            TINYINT UNSIGNED NOT NULL DEFAULT 1,
    adults            TINYINT UNSIGNED NOT NULL DEFAULT 1,
    children          TINYINT UNSIGNED NOT NULL DEFAULT 0,
    status            ENUM('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled')
                          NOT NULL DEFAULT 'pending',
    -- Price is snapshotted at booking time. If the room rate changes later,
    -- an existing booking must still show what the guest agreed to pay.
    price_per_night   DECIMAL(10, 2)   NOT NULL,
    nights            SMALLINT UNSIGNED NOT NULL,
    subtotal          DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    tax_amount        DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    service_charge    DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    total_amount      DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    amount_paid       DECIMAL(12, 2)   NOT NULL DEFAULT 0.00 COMMENT 'maintained by payment service',
    special_requests  TEXT             NULL,
    checked_in_at     DATETIME         NULL,
    checked_out_at    DATETIME         NULL,
    cancelled_at      DATETIME         NULL,
    cancellation_reason VARCHAR(255)   NULL,
    created_by        BIGINT UNSIGNED NULL COMMENT 'staff member who booked on behalf of a guest',
    created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_bookings_reference (booking_reference),
    KEY ix_bookings_user (user_id),
    KEY ix_bookings_room (room_id),
    KEY ix_bookings_status (status),
    KEY ix_bookings_checkin (check_in),
    KEY ix_bookings_checkout (check_out),
    -- The availability query looks up "active bookings for this room that
    -- overlap the requested window", so room_id + date range is the hot path.
    KEY ix_bookings_room_dates (room_id, check_in, check_out),
    KEY ix_bookings_user_status (user_id, status),
    CONSTRAINT fk_bookings_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_bookings_room
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE RESTRICT,
    CONSTRAINT fk_bookings_created_by
        FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- Additional guests on a booking (the primary guest is bookings.user_id).
-- Keeping them in a child table avoids a second user account per guest.
CREATE TABLE IF NOT EXISTS booking_guests (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    booking_id BIGINT UNSIGNED NOT NULL,
    first_name VARCHAR(80)     NOT NULL,
    last_name  VARCHAR(80)     NULL,
    is_primary TINYINT(1)      NOT NULL DEFAULT 0,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_booking_guests_booking (booking_id),
    CONSTRAINT fk_booking_guests_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 4 - RESTAURANT
-- ============================================================================

CREATE TABLE IF NOT EXISTS menu_categories (
    id         SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name       VARCHAR(60)        NOT NULL,
    slug       VARCHAR(60)        NOT NULL,
    icon       VARCHAR(60)        NULL,
    sort_order TINYINT            NOT NULL DEFAULT 0,
    is_active  TINYINT(1)         NOT NULL DEFAULT 1,
    created_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_menu_categories_slug (slug),
    UNIQUE KEY uq_menu_categories_name (name)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS menu_items (
    id           INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    category_id  SMALLINT UNSIGNED NOT NULL,
    name         VARCHAR(120)      NOT NULL,
    description  TEXT              NULL,
    price        DECIMAL(10, 2)    NOT NULL,
    image        VARCHAR(255)      NULL,
    -- Marks vegetarian/vegan/spicy items for the guest to filter by.
    is_vegetarian TINYINT(1)       NOT NULL DEFAULT 0,
    is_spicy     TINYINT(1)        NOT NULL DEFAULT 0,
    is_featured  TINYINT(1)        NOT NULL DEFAULT 0,
    -- 86'd (sold out) is different from hidden: it stays on the menu but
    -- cannot be ordered.
    is_available TINYINT(1)        NOT NULL DEFAULT 1,
    prep_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 15,
    created_at   TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_menu_items_category (category_id),
    KEY ix_menu_items_available (is_available),
    KEY ix_menu_items_price (price),
    KEY ix_menu_items_name (name),
    CONSTRAINT fk_menu_items_category
        FOREIGN KEY (category_id) REFERENCES menu_categories (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_reference CHAR(12)        NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    -- Set for room delivery so the driver knows where to go. NULL for pickup.
    room_id         INT UNSIGNED    NULL,
    booking_id      BIGINT UNSIGNED NULL COMMENT 'validated for room delivery',
    fulfilment_type ENUM('room_delivery', 'restaurant_pickup') NOT NULL DEFAULT 'restaurant_pickup',
    status          ENUM('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled')
                       NOT NULL DEFAULT 'pending',
    subtotal        DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    tax_amount      DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    service_charge  DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    total_amount    DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    amount_paid     DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    special_requests TEXT            NULL,
    delivery_notes  VARCHAR(255)     NULL,
    placed_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ready_at        DATETIME         NULL,
    delivered_at    DATETIME         NULL,
    cancelled_at    DATETIME         NULL,
    created_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_orders_reference (order_reference),
    KEY ix_orders_user (user_id),
    KEY ix_orders_room (room_id),
    KEY ix_orders_booking (booking_id),
    KEY ix_orders_status (status),
    KEY ix_orders_placed (placed_at),
    KEY ix_orders_user_status (user_id, status),
    CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_orders_room
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE SET NULL,
    CONSTRAINT fk_orders_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- order_items
-- name and price are snapshotted so that editing a menu item later does not
-- rewrite the financial history of past orders.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id      BIGINT UNSIGNED NOT NULL,
    menu_item_id  INT UNSIGNED    NULL COMMENT 'null if the item was deleted from the menu',
    item_name     VARCHAR(120)     NOT NULL,
    unit_price    DECIMAL(10, 2)   NOT NULL,
    quantity      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    line_total    DECIMAL(12, 2)   NOT NULL,
    special_instructions VARCHAR(255) NULL,
    created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_order_items_order (order_id),
    KEY ix_order_items_menu_item (menu_item_id),
    CONSTRAINT fk_order_items_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_order_items_menu_item
        FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 5 - PAYMENTS AND INVOICES
-- ============================================================================

CREATE TABLE IF NOT EXISTS payments (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    payment_reference CHAR(20)        NOT NULL COMMENT 'public reference shown to the guest',
    transaction_id    VARCHAR(64)     NULL COMMENT 'id returned by the payment provider',
    user_id           BIGINT UNSIGNED NOT NULL,
    -- Exactly one of these is set; the CHECK constraint enforces it so a
    -- payment can never be attached to both a booking and an order.
    booking_id        BIGINT UNSIGNED NULL,
    order_id          BIGINT UNSIGNED NULL,
    amount            DECIMAL(12, 2)   NOT NULL,
    currency          CHAR(3)          NOT NULL DEFAULT 'USD',
    payment_method    ENUM('card', 'mobile_money', 'cash') NOT NULL,
    status            ENUM('pending', 'processing', 'completed', 'failed', 'refunded')
                          NOT NULL DEFAULT 'pending',
    failure_reason    VARCHAR(255)     NULL,
    -- Opaque JSON from the provider, kept for reconciliation and debugging.
    provider_response JSON             NULL,
    paid_at           DATETIME         NULL,
    refunded_at       DATETIME         NULL,
    created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_payments_reference (payment_reference),
    KEY ix_payments_user (user_id),
    KEY ix_payments_booking (booking_id),
    KEY ix_payments_order (order_id),
    KEY ix_payments_status (status),
    KEY ix_payments_created (created_at),
    -- Reports group revenue by date and method, so index both together.
    KEY ix_payments_status_created (status, created_at),
    KEY ix_payments_method (payment_method),
    CONSTRAINT chk_payment_single_target CHECK (
        (booking_id IS NULL) <> (order_id IS NULL)
    ),
    CONSTRAINT fk_payments_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_payments_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
    CONSTRAINT fk_payments_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- invoices
-- One invoice per booking or order. totals are copied from the source so the
-- printed document remains accurate even if tax rules change later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    invoice_number    VARCHAR(30)     NOT NULL,
    booking_id        BIGINT UNSIGNED NULL,
    order_id          BIGINT UNSIGNED NULL,
    user_id           BIGINT UNSIGNED NOT NULL,
    subtotal          DECIMAL(12, 2)   NOT NULL,
    tax_amount        DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    service_charge    DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    total_amount      DECIMAL(12, 2)   NOT NULL,
    amount_paid       DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    balance_due       DECIMAL(12, 2)   NOT NULL DEFAULT 0.00,
    status            ENUM('unpaid', 'partially_paid', 'paid', 'void') NOT NULL DEFAULT 'unpaid',
    payment_method    ENUM('card', 'mobile_money', 'cash') NULL,
    payment_reference VARCHAR(20)     NULL,
    issued_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_invoices_number (invoice_number),
    UNIQUE KEY uq_invoices_booking (booking_id),
    UNIQUE KEY uq_invoices_order (order_id),
    KEY ix_invoices_user (user_id),
    KEY ix_invoices_status (status),
    KEY ix_invoices_issued (issued_at),
    CONSTRAINT fk_invoices_booking
        FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
    CONSTRAINT fk_invoices_order
        FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_invoices_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 6 - REVIEWS
-- ---------------------------------------------------------------------------
-- entity_type + entity_id gives one polymorphic table for hotel, room,
-- restaurant and food item reviews, instead of four near identical tables.
-- A guest can review a room only after a completed stay, which is enforced in
-- the service layer because it requires a join across bookings.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reviews (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id     BIGINT UNSIGNED NOT NULL,
    entity_type ENUM('hotel', 'room', 'restaurant', 'food_item', 'service') NOT NULL,
    entity_id   BIGINT UNSIGNED NULL COMMENT 'null when entity_type = hotel',
    rating      TINYINT UNSIGNED NOT NULL COMMENT '1 to 5',
    title       VARCHAR(150)     NOT NULL,
    comment     TEXT             NOT NULL,
    -- Moderation: hidden reviews stay in the table so they can be restored.
    is_visible  TINYINT(1)       NOT NULL DEFAULT 1,
    is_flagged  TINYINT(1)       NOT NULL DEFAULT 0,
    staff_reply  TEXT             NULL COMMENT 'response from hotel management',
    replied_at  DATETIME         NULL,
    created_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_reviews_entity (entity_type, entity_id),
    KEY ix_reviews_user (user_id),
    KEY ix_reviews_visible (is_visible),
    KEY ix_reviews_created (created_at),
    -- One review per user per target. This unique index is the database level
    -- guarantee against review spam.
    UNIQUE KEY uq_reviews_user_entity (user_id, entity_type, entity_id),
    CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT fk_reviews_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 7 - CHAT
-- ---------------------------------------------------------------------------
-- Conversations are modelled explicitly rather than implied by message rows,
-- so a conversation has a stable id, a purpose (who the guest is talking to)
-- and unread tracking that survives message deletion.
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- What the conversation is about, so staff can triage their inbox.
    subject       VARCHAR(80)      NOT NULL DEFAULT 'General Enquiry',
    context_type  ENUM('support', 'reception', 'restaurant', 'booking') NOT NULL DEFAULT 'support',
    -- Resolved conversations are hidden from the active inbox.
    is_closed     TINYINT(1)       NOT NULL DEFAULT 0,
    last_message_at DATETIME       NULL,
    created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_conversations_closed (is_closed),
    KEY ix_conversations_last_message (last_message_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    -- Per participant read cursor. Messages with id <= last_read_id are seen.
    last_read_id    BIGINT UNSIGNED NULL,
    joined_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id),
    KEY ix_participants_user (user_id),
    CONSTRAINT fk_participants_conversation
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_participants_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    conversation_id BIGINT UNSIGNED NOT NULL,
    sender_id       BIGINT UNSIGNED NOT NULL,
    body            TEXT             NOT NULL,
    read_at         DATETIME         NULL,
    created_at      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    -- Chat threads are read newest-last, so the composite index matches the
    -- access pattern: filter by conversation, order by id.
    KEY ix_messages_conversation_id (conversation_id, id),
    KEY ix_messages_sender (sender_id),
    KEY ix_messages_unread (read_at),
    CONSTRAINT fk_messages_conversation
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender
        FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 8 - NOTIFICATIONS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id    BIGINT UNSIGNED NOT NULL,
    type       VARCHAR(50)  NOT NULL COMMENT 'booking_confirmation, payment_success, ...',
    title      VARCHAR(150) NOT NULL,
    body       TEXT         NULL,
    -- JSON describing where to navigate when the notification is clicked,
    -- e.g. { "url": "/pages/guest/bookings.html", "booking_id": 42 }
    data       JSON         NULL,
    is_read    TINYINT(1)   NOT NULL DEFAULT 0,
    read_at    DATETIME     NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- The notification bell queries "my unread, newest first".
    KEY ix_notifications_user_unread (user_id, is_read, created_at),
    KEY ix_notifications_user (user_id),
    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ============================================================================
--  SECTION 9 - SYSTEM BRANDING
-- ============================================================================

-- ---------------------------------------------------------------------------
-- system_settings
-- The hotel's own name, logo and contact details, editable by an administrator
-- from the admin Settings screen.
--
-- WHY A SINGLE ROW RATHER THAN A KEY/VALUE TABLE
-- There is exactly one hotel, so the row is pinned to id = 1 by a CHECK
-- constraint. A key/value table would allow nonsense keys and would need a
-- JSON blob or a row per key; one row with named columns keeps the contract
-- obvious and lets the database reject anything but the one legal row.
--
-- WHY THE LOGO IS A PATH, NOT A BLOB
-- The file lives outside the web root in uploads/hotel/ and is streamed by
-- GET /api/settings/logo. Storing bytes in the row would duplicate the file,
-- bloat every settings read and make the upload endpoint's job impossible.
--
-- `logo_url` is the alternative to an upload: a logo already hosted elsewhere
-- (a CDN, the brand agency) is stored as an absolute http(s) URL and takes
-- precedence over `logo_path`. Exactly one is expected to be set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    id             TINYINT UNSIGNED NOT NULL DEFAULT 1,
    system_name    VARCHAR(120) NOT NULL DEFAULT 'Aurelia Grand Hotel',
    -- The small line under the wordmark, e.g. 'Nairobi, Kenya'. Optional.
    tagline        VARCHAR(150) NULL,
    -- Stored path under uploads/, e.g. 'hotel/abc123.png'. Set by the
    -- multipart upload endpoint.
    logo_path      VARCHAR(255) NULL,
    -- Absolute http(s) URL for a logo hosted elsewhere.
    logo_url       VARCHAR(500) NULL,
    contact_phone  VARCHAR(40)  NULL,
    contact_email  VARCHAR(190) NULL,
    contact_address VARCHAR(255) NULL,
    -- Who changed the branding and when. SET NULL so the settings row survives
    -- the deletion of the administrator who set it.
    updated_by     BIGINT UNSIGNED NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT chk_system_settings_single_row CHECK (id = 1),
    CONSTRAINT fk_system_settings_updated_by
        FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- The single settings row. ON DUPLICATE KEY UPDATE makes re-running the
-- schema a no-op instead of an error, and deliberately does NOT overwrite
-- edited values: the defaults below only apply the very first time.
INSERT INTO system_settings (id, system_name, tagline, contact_phone, contact_email, contact_address)
VALUES (1, 'Aurelia Grand Hotel', 'Nairobi, Kenya', '+254 700 000 000', 'reservations@example.com', '24 Riverside Drive, Nairobi, Kenya')
ON DUPLICATE KEY UPDATE id = id;

SET FOREIGN_KEY_CHECKS = 1;