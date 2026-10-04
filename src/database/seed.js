/**
 * src/database/seed.js
 *
 * WHAT THIS MODULE DOES
 * Populates the database with everything needed to run and demonstrate the
 * application: roles, permissions, demo accounts, room types, rooms,
 * amenities, the restaurant menu and sample reviews.
 *
 * WHY IT EXISTS
 * A hotel system is hard to evaluate without data. This script produces a
 * realistic dataset so every screen has something to display and every flow
 * can be tested immediately after `npm run seed`.
 *
 * IDEMPOTENCY
 * The script is safe to run repeatedly. Reference data (roles, permissions,
 * room types, menu categories) is inserted with INSERT IGNORE and unique keys,
 * and demo users are upserted, so re-running updates rather than duplicating.
 *
 * SECURITY
 * Demo passwords live in this development script only. They are never
 * referenced by application logic, and the file documents that fact.
 *
 * COMMUNICATION
 * Run with: npm run seed
 * Database tables written: roles, permissions, role_permissions, users,
 *   room_types, rooms, amenities, room_amenities, menu_categories, menu_items,
 *   reviews, bookings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, execute, query, withTransaction, closePool } from '../config/db.js';
import { PERMISSION_CATALOG } from '../repositories/permission.repository.js';

/**
 * Local menu photography, keyed by the slug in MENU_ITEMS.
 *
 * The photographs are committed under public/assets/images/dining and were
 * fetched by scripts/fetch-menu-images.mjs from Wikimedia Commons, whose files
 * carry explicit licences. Storing a path rather than a remote URL means the
 * restaurant page renders with no third party request and no broken image when
 * the network is unavailable.
 *
 * Each entry also records the source title and licence, which satisfy the CC BY
 * and CC BY-SA attribution requirements. See public/assets/images/CREDITS.md.
 *
 * Only the path is written to the database: the `image` column is a VARCHAR
 * holding a URL or a public path, and the browser is given a src, not a
 * citation. Attribution lives with the code instead.
 */
const MENU_IMAGE_MANIFEST = JSON.parse(
    readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets', 'images', 'dining', 'manifest.json'),
        'utf8',
    ),
);

/** Menu slug -> local image path. */
const MENU_IMAGES = Object.fromEntries(
    Object.entries(MENU_IMAGE_MANIFEST).map(([slug, entry]) => [
        slug,
        // Tolerates the older string-only manifest format.
        typeof entry === 'string' ? entry : entry.path,
    ]),
);

const BCRYPT_ROUNDS = 10; // lower than production (12) so seeding stays fast

/**
 * Demo credentials. Documented here and in the README for local development
 * only. Every account uses a password meeting the production strength policy.
 */
export const DEMO_ACCOUNTS = [
    { email: 'admin@example.com',       password: 'Admin@1234',      firstName: 'Amara',   lastName: 'Osei',      role: 'admin' },
    { email: 'manager@example.com',     password: 'Manager@1234',    firstName: 'Daniel',  lastName: 'Mwangi',    role: 'manager' },
    { email: 'reception@example.com',   password: 'Reception@1234',  firstName: 'Grace',   lastName: 'Nkemdi',    role: 'receptionist' },
    { email: 'restaurant@example.com',  password: 'Restaurant@1234', firstName: 'Marco',   lastName: 'Rossi',     role: 'restaurant_staff' },
    { email: 'housekeeping@example.com',password: 'Housekeep@1234',  firstName: 'Fatima',  lastName: 'Hassan',    role: 'housekeeping' },
    { email: 'guest@example.com',       password: 'Guest@1234',      firstName: 'James',   lastName: 'Carter',    role: 'guest' },
    { email: 'sarah@example.com',       password: 'Guest@1234',      firstName: 'Sarah',   lastName: 'Miller',    role: 'guest' },
    { email: 'david@example.com',       password: 'Guest@1234',      firstName: 'David',   lastName: 'Chen',      role: 'guest' },
];

const ROLE_DESCRIPTIONS = {
    guest: 'Hotel guest with booking, dining and messaging access',
    receptionist: 'Front desk staff managing reservations and check-in',
    restaurant_staff: 'Restaurant team managing the kitchen and orders',
    housekeeping: 'Housekeeping team managing room status',
    manager: 'Hotel manager with oversight across departments',
    admin: 'System administrator with full access',
};

/**
 * What each role may do. Admin gets everything implicitly through requireRole,
 * but the grants are explicit here so the admin role screen is meaningful.
 */
const ROLE_PERMISSIONS = {
    guest: [
        'booking:create', 'booking:read', 'booking:cancel',
        'room:read', 'order:create', 'order:read',
        'menu:read', 'payment:create', 'payment:read',
        'invoice:read', 'review:create', 'chat:send',
    ],
    receptionist: [
        'booking:create', 'booking:read', 'booking:update', 'booking:cancel',
        'booking:checkin', 'room:read', 'room:status', 'user:read',
        'payment:create', 'payment:read', 'invoice:read', 'chat:reply',
        'review:moderate', 'order:read',
    ],
    restaurant_staff: [
        'order:read', 'order:update', 'menu:read', 'menu:write',
        'room:read', 'chat:reply', 'review:moderate',
    ],
    housekeeping: ['room:read', 'room:status'],
    manager: [
        'booking:create', 'booking:read', 'booking:update', 'booking:cancel',
        'booking:checkin', 'room:read', 'room:create', 'room:update',
        'room:status', 'order:read', 'order:update', 'menu:read',
        'menu:write', 'payment:read', 'payment:refund', 'invoice:read',
        'review:moderate', 'chat:reply', 'user:read', 'report:read',
        'audit:read',
    ],
    admin: Object.keys(PERMISSION_CATALOG),
};

const ROOM_TYPES = [
    {
        slug: 'standard', name: 'Standard Room', basePrice: 95.00, maxCapacity: 2,
        sizeSqm: 24, bed: 'One Queen bed',
        image: '/assets/images/rooms/standard.jpg',
        description: 'A comfortable, well appointed room for solo travellers or couples, with a work desk and blackout curtains.',
    },
    {
        slug: 'deluxe', name: 'Deluxe Room', basePrice: 145.00, maxCapacity: 3,
        sizeSqm: 32, bed: 'One King bed',
        image: '/assets/images/rooms/deluxe.jpg',
        description: 'More space and natural light than a Standard room, with a seating area and premium bathroom amenities.',
    },
    {
        slug: 'executive', name: 'Executive Room', basePrice: 210.00, maxCapacity: 3,
        sizeSqm: 40, bed: 'One King bed',
        image: '/assets/images/rooms/executive.jpg',
        description: 'Designed for business travellers, with a large desk, high speed internet and access to the executive lounge.',
    },
    {
        slug: 'suite', name: 'Suite', basePrice: 340.00, maxCapacity: 4,
        sizeSqm: 58, bed: 'One King bed and a sofa bed',
        image: '/assets/images/rooms/suite.jpg',
        description: 'A separate living space, complimentary minibar and a deep soaking bath. Ideal for longer stays.',
    },
    {
        slug: 'family', name: 'Family Room', basePrice: 265.00, maxCapacity: 5,
        sizeSqm: 50, bed: 'One Queen bed and two singles',
        image: '/assets/images/rooms/family.jpg',
        description: 'Two connecting rooms configured for families, with a child friendly layout and extra bathroom facilities.',
    },
];

const AMENITIES = [
    { name: 'Free WiFi',          icon: 'fa-wifi',          description: 'High speed wireless internet throughout the room' },
    { name: 'Air Conditioning',   icon: 'fa-snowflake',     description: 'Individual climate control' },
    { name: 'Flat Screen TV',     icon: 'fa-tv',            description: '42 inch television with cable channels' },
    { name: 'Mini Bar',           icon: 'fa-mug-hot',       description: 'Refreshments replenished daily' },
    { name: 'Safe',               icon: 'fa-lock',          description: 'In-room digital safe' },
    { name: 'Coffee Maker',       icon: 'fa-coffee',        description: 'Filter coffee and tea provided' },
    { name: 'Hairdryer',          icon: 'fa-wind',          description: 'Hairdryer in the bathroom' },
    { name: 'Bathrobe',           icon: 'fa-shirt',         description: 'Soft cotton bathrobes provided' },
    { name: 'Work Desk',          icon: 'fa-laptop',        description: 'Dedicated workspace with power outlets' },
    { name: 'Balcony',            icon: 'fa-door-open',     description: 'Private balcony with city or garden view' },
    { name: 'Bath Tub',           icon: 'fa-bath',          description: 'Deep soaking bath' },
    { name: 'Accessible Shower',  icon: 'fa-wheelchair',    description: 'Roll in shower with grab rails' },
];

const MENU_CATEGORIES = [
    { slug: 'breakfast', name: 'Breakfast', icon: 'fa-mug-hot', sortOrder: 1 },
    { slug: 'lunch',     name: 'Lunch',     icon: 'fa-utensils', sortOrder: 2 },
    { slug: 'dinner',    name: 'Dinner',    icon: 'fa-plate-empty', sortOrder: 3 },
    { slug: 'drinks',    name: 'Drinks',    icon: 'fa-martini-glass', sortOrder: 4 },
    { slug: 'desserts',  name: 'Desserts',  icon: 'fa-ice-cream', sortOrder: 5 },
    { slug: 'snacks',    name: 'Snacks',    icon: 'fa-cookie-bite', sortOrder: 6 },
];

const MENU_ITEMS = [
    // category slug, name, description, price, tags
    { slug: 'continental-breakfast', category: 'breakfast', name: 'Continental Breakfast', description: 'Selection of pastries, fresh fruit, yoghurt, juice and freshly brewed coffee.', price: 18.00, vegetarian: 1, prep: 15 },
    { slug: 'full-english-breakfast', category: 'breakfast', name: 'Full English Breakfast',  description: 'Two eggs, pork sausages, grilled tomatoes, mushrooms, baked beans and toast.', price: 24.00, vegetarian: 0, prep: 20 },
    { slug: 'avocado-toast', category: 'breakfast', name: 'Avocado Toast',           description: 'Sourdough toast with smashed avocado, poached eggs, chilli and lime.', price: 14.50, vegetarian: 1, prep: 12 },
    { slug: 'pancake-stack', category: 'breakfast', name: 'Pancake Stack',          description: 'Three fluffy pancakes with maple syrup, seasonal berries and whipped cream.', price: 13.00, vegetarian: 1, prep: 15 },

    { slug: 'chicken-caesar-salad', category: 'lunch', name: 'Chicken Caesar Salad',      description: 'Cos lettuce, grilled chicken breast, parmesan, croutons and Caesar dressing.', price: 16.50, vegetarian: 0, prep: 12 },
    { slug: 'grilled-vegetable-platter', category: 'lunch', name: 'Grilled Vegetable Platter', description: 'Seasonal vegetables grilled with herbs and served with a balsamic reduction.', price: 15.00, vegetarian: 1, prep: 15 },
    { slug: 'club-sandwich', category: 'lunch', name: 'Club Sandwich',             description: 'Grilled chicken, bacon, lettuce and tomato on toasted bread with chips.', price: 15.50, vegetarian: 0, prep: 12 },
    { slug: 'margherita-pizza', category: 'lunch', name: 'Margherita Pizza',          description: 'Stone baked pizza with San Marzano tomato, mozzarella and fresh basil.', price: 17.00, vegetarian: 1, prep: 18 },
    { slug: 'mushroom-risotto', category: 'lunch', name: 'Mushroom Risotto',          description: 'Creamy arborio rice with wild mushrooms, parmesan and truffle oil.', price: 21.00, vegetarian: 1, prep: 25 },

    { slug: 'grilled-salmon', category: 'dinner', name: 'Grilled Salmon',        description: 'Atlantic salmon fillet with seasonal vegetables and a lemon butter sauce.', price: 32.00, vegetarian: 0, prep: 25 },
    { slug: 'ribeye-steak', category: 'dinner', name: 'Ribeye Steak',          description: '300g ribeye grilled to your preference, served with roast potatoes and greens.', price: 45.00, vegetarian: 0, prep: 30 },
    { slug: 'chicken-tikka-masala', category: 'dinner', name: 'Chicken Tikka Masala',  description: 'Chargrilled chicken in a spiced tomato and cream sauce, served with naan.', price: 24.00, vegetarian: 0, spicy: 1, prep: 25 },
    { slug: 'pasta-carbonara', category: 'dinner', name: 'Pasta Carbonara',       description: 'Spaghetti with pancetta, egg yolk, pecorino and black pepper.', price: 19.50, vegetarian: 0, prep: 18 },
    { slug: 'vegetable-curry', category: 'dinner', name: 'Vegetable Curry',       description: 'Seasonal vegetables in a fragrant coconut and spice sauce with jasmine rice.', price: 20.00, vegetarian: 1, spicy: 1, prep: 22 },

    { slug: 'fresh-orange-juice', category: 'drinks', name: 'Fresh Orange Juice',  description: 'Served chilled, freshly squeezed each morning.', price: 6.00, vegetarian: 1, prep: 5 },
    { slug: 'cappuccino', category: 'drinks', name: 'Cappuccino',          description: 'Espresso topped with steamed milk and a dusting of cocoa.', price: 5.00, vegetarian: 1, prep: 7 },
    { slug: 'still-water-750ml', category: 'drinks', name: 'Still Water 750ml',   description: 'Bottled mineral water.', price: 3.50, vegetarian: 1, prep: 2 },
    { slug: 'house-red-wine', category: 'drinks', name: 'House Red Wine',     description: 'A glass of the house red, a light fruity blend.', price: 9.00, vegetarian: 1, prep: 5 },
    { slug: 'classic-martini', category: 'drinks', name: 'Classic Martini',     description: 'Gin and dry vermouth with a twist of lemon.', price: 14.00, vegetarian: 1, prep: 8 },

    { slug: 'chocolate-lava-cake', category: 'desserts', name: 'Chocolate Lava Cake', description: 'Warm chocolate sponge with a molten centre and vanilla ice cream.', price: 11.00, vegetarian: 1, prep: 15 },
    { slug: 'new-york-cheesecake', category: 'desserts', name: 'New York Cheesecake', description: 'Baked cheesecake with a crisp biscuit base and seasonal coulis.', price: 9.50, vegetarian: 1, prep: 8 },
    { slug: 'fresh-fruit-platter', category: 'desserts', name: 'Fresh Fruit Platter', description: 'A generous selection of sliced seasonal fruit.', price: 8.50, vegetarian: 1, prep: 10 },
    { slug: 'sorbet-of-the-day', category: 'desserts', name: 'Sorbet of the Day',   description: 'Two scoops of seasonal sorbet, served chilled.', price: 7.00, vegetarian: 1, prep: 5 },

    { slug: 'chicken-burger', category: 'snacks', name: 'Chicken Burger',   description: 'Grilled chicken breast in a brioche bun with lettuce and house sauce.', price: 14.00, vegetarian: 0, prep: 15 },
    { slug: 'french-fries', category: 'snacks', name: 'French Fries',     description: 'Hand cut potatoes twice fried with sea salt.', price: 6.00, vegetarian: 1, prep: 10 },
    { slug: 'loaded-nachos', category: 'snacks', name: 'Loaded Nachos',    description: 'Corn tortilla chips with cheese sauce, jalapenos and salsa.', price: 12.00, vegetarian: 1, spicy: 1, prep: 12 },
    { slug: 'chicken-wings', category: 'snacks', name: 'Chicken Wings',    description: 'Eight wings glazed in a choice of sauce, served with dip.', price: 13.00, vegetarian: 0, spicy: 1, prep: 18 },
];

/** Deterministic pseudo-random so repeated seeds produce the same dataset. */
function seededRandom(seed) {
    let value = seed;
    return () => {
        value = (value * 1_103_515_245 + 12_345) % 2_147_483_648;
        return value / 2_147_483_648;
    };
}

// ---------------------------------------------------------------------------
// Seeding steps
// ---------------------------------------------------------------------------

async function seedRolesAndPermissions() {
    console.log('Seeding roles and permissions...');

    // Permissions first, since roles reference them.
    for (const [code, description] of Object.entries(PERMISSION_CATALOG)) {
        await execute(
            `INSERT INTO permissions (code, description) VALUES (:code, :description)
             ON DUPLICATE KEY UPDATE description = VALUES(description)`,
            { code, description },
        );
    }
    console.log(`  ${Object.keys(PERMISSION_CATALOG).length} permissions`);

    const roleIds = {};
    for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
        await execute(
            `INSERT INTO roles (name, description) VALUES (:name, :description)
             ON DUPLICATE KEY UPDATE description = VALUES(description)`,
            { name, description },
        );
        const [rows] = await pool.query('SELECT id FROM roles WHERE name = ?', [name]);
        roleIds[name] = rows[0].id;
    }
    console.log(`  ${Object.keys(ROLE_DESCRIPTIONS).length} roles`);

    // Clear and rebuild grants so the map always matches this file exactly.
    await execute('DELETE FROM role_permissions');
    const [permissionRows] = await pool.query('SELECT id, code FROM permissions');
    const permissionIds = Object.fromEntries(permissionRows.map((row) => [row.code, row.id]));

    let grantCount = 0;
    for (const [roleName, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        for (const code of permissions) {
            const permissionId = permissionIds[code];
            if (!permissionId) {
                throw new Error(`Unknown permission "${code}" referenced by role "${roleName}"`);
            }
            await execute(
                'INSERT INTO role_permissions (role_id, permission_id) VALUES (:roleId, :permissionId)',
                { roleId: roleIds[roleName], permissionId },
            );
            grantCount += 1;
        }
    }
    console.log(`  ${grantCount} role-permission grants`);

    return roleIds;
}

async function seedUsers(roleIds) {
    console.log('Seeding demo users...');

    const ids = {};
    for (const account of DEMO_ACCOUNTS) {
        const existing = await query('SELECT id, password_hash FROM users WHERE email = :email', {
            email: account.email,
        });

        const passwordHash = await bcrypt.hash(account.password, BCRYPT_ROUNDS);

        if (existing.length > 0) {
            // Update so demo credentials always match the documented ones.
            await execute(
                `UPDATE users SET role_id = :roleId, first_name = :firstName, last_name = :lastName,
                        phone = :phone, password_hash = :passwordHash, is_active = 1
                 WHERE id = :id`,
                {
                    id: existing[0].id,
                    roleId: roleIds[account.role],
                    firstName: account.firstName,
                    lastName: account.lastName,
                    phone: '+254700000000',
                    passwordHash,
                },
            );
            ids[account.email] = existing[0].id;
        } else {
            const result = await execute(
                `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, is_active, email_verified, email_verified_at)
                 VALUES (:roleId, :firstName, :lastName, :email, :phone, :passwordHash, 1, 1, NOW())`,
                {
                    roleId: roleIds[account.role],
                    firstName: account.firstName,
                    lastName: account.lastName,
                    email: account.email,
                    phone: '+254700000000',
                    passwordHash,
                },
            );
            ids[account.email] = result.insertId;
        }
    }
    console.log(`  ${DEMO_ACCOUNTS.length} demo accounts`);
    return ids;
}

async function seedRooms() {
    console.log('Seeding room types and rooms...');

    const typeIds = {};
    for (const type of ROOM_TYPES) {
        await execute(
            `INSERT INTO room_types (name, slug, description, base_price, max_capacity, size_sqm, bed_configuration, image)
             VALUES (:name, :slug, :description, :basePrice, :maxCapacity, :sizeSqm, :bed, :image)
             ON DUPLICATE KEY UPDATE
                description = VALUES(description), base_price = VALUES(base_price),
                max_capacity = VALUES(max_capacity), size_sqm = VALUES(size_sqm),
                bed_configuration = VALUES(bed_configuration), image = VALUES(image)`,
            type,
        );
        const [rows] = await pool.query('SELECT id FROM room_types WHERE slug = ?', [type.slug]);
        typeIds[type.slug] = rows[0].id;
    }
    console.log(`  ${ROOM_TYPES.length} room types`);

    // 40 rooms: 4 floors, 10 rooms per floor, varied by type.
    const layout = [
        { type: 'standard',  rooms: [101, 102, 103, 104, 105] },
        { type: 'deluxe',    rooms: [106, 107, 108, 109, 110] },
        { type: 'executive', rooms: [111, 112, 113] },
        { type: 'family',    rooms: [114, 115] },
    ];

    const floorLayout = [layout, layout, layout, layout];
    const random = seededRandom(42);
    let created = 0;

    for (let floor = 1; floor <= 4; floor += 1) {
        for (const group of floorLayout[floor - 1]) {
            for (const base of group.rooms) {
                const roomNumber = `${floor}${String(base).slice(1)}`;
                const type = ROOM_TYPES.find((t) => t.slug === group.type);
                // Slight variation so price sorting is meaningful.
                const price = Number((type.basePrice * (0.95 + random() * 0.15)).toFixed(2));

                await execute(
                    `INSERT INTO rooms (room_number, room_type_id, floor, capacity, price_per_night, description, status)
                     VALUES (:roomNumber, :typeId, :floor, :capacity, :price, :description, 'available')
                     ON DUPLICATE KEY UPDATE
                        price_per_night = VALUES(price_per_night),
                        capacity = VALUES(capacity),
                        description = VALUES(description)`,
                    {
                        roomNumber,
                        typeId: typeIds[group.type],
                        floor,
                        capacity: type.maxCapacity,
                        price,
                        description: type.description,
                    },
                );
                created += 1;
            }
        }
    }
    console.log(`  ${created} rooms`);

    return typeIds;
}

async function seedAmenities() {
    console.log('Seeding amenities...');

    const amenityIds = {};
    for (const amenity of AMENITIES) {
        await execute(
            `INSERT INTO amenities (name, icon, description) VALUES (:name, :icon, :description)
             ON DUPLICATE KEY UPDATE icon = VALUES(icon), description = VALUES(description)`,
            amenity,
        );
        const [rows] = await pool.query('SELECT id FROM amenities WHERE name = ?', [amenity.name]);
        amenityIds[amenity.name] = rows[0].id;
    }
    console.log(`  ${AMENITIES.length} amenities`);

    // Every room gets the baseline amenities; higher tiers get more.
    const baseline = ['Free WiFi', 'Air Conditioning', 'Flat Screen TV', 'Safe', 'Hairdryer'];
    const deluxe = [...baseline, 'Mini Bar', 'Coffee Maker', 'Bathrobe'];
    const executive = [...deluxe, 'Work Desk', 'Bath Tub'];
    const suite = [...executive, 'Balcony'];
    const family = [...deluxe, 'Accessible Shower'];

    const byType = { standard: baseline, deluxe, executive, suite, family };

    await execute('DELETE FROM room_amenities');

    const rooms = await query('SELECT id, room_type_id FROM rooms');
    const types = await query('SELECT id, slug FROM room_types');
    const typeById = Object.fromEntries(types.map((t) => [t.id, t.slug]));

    let links = 0;
    for (const room of rooms) {
        const slug = typeById[room.room_type_id];
        for (const name of byType[slug] || baseline) {
            await execute(
                'INSERT IGNORE INTO room_amenities (room_id, amenity_id) VALUES (:roomId, :amenityId)',
                { roomId: room.id, amenityId: amenityIds[name] },
            );
            links += 1;
        }
    }
    console.log(`  ${links} room-amenity links`);

    return amenityIds;
}

async function seedMenu() {
    console.log('Seeding restaurant menu...');

    const categoryIds = {};
    for (const category of MENU_CATEGORIES) {
        await execute(
            `INSERT INTO menu_categories (name, slug, icon, sort_order) VALUES (:name, :slug, :icon, :sortOrder)
             ON DUPLICATE KEY UPDATE icon = VALUES(icon), sort_order = VALUES(sort_order)`,
            category,
        );
        const [rows] = await pool.query('SELECT id FROM menu_categories WHERE slug = ?', [category.slug]);
        categoryIds[category.slug] = rows[0].id;
    }
    console.log(`  ${MENU_CATEGORIES.length} categories`);

    let itemCount = 0;
    let imageUpdates = 0;
    for (const item of MENU_ITEMS) {
        const categoryId = categoryIds[item.category];
        const existing = await query(
            'SELECT id FROM menu_items WHERE name = :name AND category_id = :categoryId',
            { name: item.name, categoryId },
        );

        const image = MENU_IMAGES[item.slug] || null;

        if (existing.length === 0) {
            await execute(
                `INSERT INTO menu_items
                   (category_id, name, description, price, image, is_vegetarian, is_spicy, is_available, prep_minutes)
                 VALUES (:categoryId, :name, :description, :price, :image, :vegetarian, :spicy, 1, :prep)`,
                {
                    categoryId,
                    name: item.name,
                    description: item.description,
                    price: item.price,
                    image,
                    vegetarian: item.vegetarian || 0,
                    spicy: item.spicy || 0,
                    prep: item.prep,
                },
            );
            itemCount += 1;
        } else if (existing[0].image !== image) {
            // The item already exists from an earlier seed, so backfill the
            // photograph rather than leaving the card without one. Only the
            // image is touched: prices and availability are staff decisions
            // and a re-seed should not undo them.
            await execute('UPDATE menu_items SET image = :image WHERE id = :id', {
                image,
                id: existing[0].id,
            });
            imageUpdates += 1;
        }
    }
    console.log(`  ${itemCount} new menu items (${MENU_ITEMS.length} total defined)`);
    if (imageUpdates > 0) console.log(`  ${imageUpdates} existing menu images refreshed`);
}

async function seedReviews(userIds) {
    console.log('Seeding sample reviews...');

    const [existing] = await pool.query("SELECT COUNT(*) AS total FROM reviews WHERE entity_type = 'hotel'");
    if (Number(existing[0].total) > 0) {
        console.log('  reviews already present, skipping');
        return;
    }

    const rooms = await query('SELECT id, room_number FROM rooms ORDER BY id LIMIT 3');
    const guests = [userIds['sarah@example.com'], userIds['david@example.com'], userIds['guest@example.com']];

    const samples = [
        { type: 'hotel',  id: null, rating: 5, title: 'Outstanding service from arrival to departure', comment: 'The welcome at reception was warm and quick, and the team remembered our names for the whole stay. The breakfast buffet was exceptional and housekeeping kept the room spotless.' },
        { type: 'hotel',  id: null, rating: 4, title: 'Beautiful hotel, minor wait for check-in', comment: 'Genuinely a lovely property and the location is perfect for the city. We waited about fifteen minutes to be checked in on a busy afternoon, but staff kept us informed and offered a drink while we waited.' },
        { type: 'hotel',  id: null, rating: 5, title: 'Would stay again without hesitation', comment: 'We booked the suite for an anniversary and it exceeded expectations. The bed was incredibly comfortable and the view over the gardens was worth the upgrade on its own.' },
        { type: 'room',   id: rooms[0]?.id, rating: 5, title: 'Spotless and very comfortable', comment: 'The room was quiet despite being central, and the air conditioning worked perfectly. Plenty of outlets and a genuinely comfortable desk.' },
        { type: 'room',   id: rooms[1]?.id, rating: 4, title: 'Great room, slightly small bathroom', comment: 'Everything we needed and the bed was excellent. The bathroom is compact for the room size but well equipped.' },
        { type: 'restaurant', id: null, rating: 5, title: 'The restaurant is a highlight of the stay', comment: 'Dinner service was attentive without hovering, and the seasonal menu changed during our week. The grilled salmon in particular was excellent.' },
        { type: 'service', id: null, rating: 4, title: 'Staff went out of their way to help', comment: 'We needed a late check-out and it was arranged within minutes. Requests through the chat system were answered quickly too.' },
    ];

    for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        const guestId = guests[index % guests.length];
        if (!guestId) continue;

        await execute(
            `INSERT IGNORE INTO reviews (user_id, entity_type, entity_id, rating, title, comment)
             VALUES (:userId, :entityType, :entityId, :rating, :title, :comment)`,
            {
                userId: guestId,
                entityType: sample.type,
                entityId: sample.id,
                rating: sample.rating,
                title: sample.title,
                comment: sample.comment,
            },
        );
    }
    console.log(`  ${samples.length} reviews`);
}

async function seedSampleBookings(userIds) {
    console.log('Seeding sample bookings...');

    const [existing] = await pool.query('SELECT COUNT(*) AS total FROM bookings');
    if (Number(existing[0].total) > 0) {
        console.log('  bookings already present, skipping');
        return;
    }

    const rooms = await query("SELECT id, room_number, price_per_night FROM rooms WHERE status = 'available' ORDER BY id LIMIT 6");
    const guests = [userIds['sarah@example.com'], userIds['david@example.com'], userIds['guest@example.com']];

    const today = new Date();
    const dateIn = (offset) => {
        const value = new Date(today);
        value.setDate(value.getDate() + offset);
        return value.toISOString().slice(0, 10);
    };

    const plans = [
        { offsetIn: 3,  nights: 3, status: 'confirmed', guest: 0 },
        { offsetIn: 7,  nights: 2, status: 'pending',   guest: 1 },
        { offsetIn: -14, nights: 4, status: 'checked_out', guest: 2 },
        { offsetIn: 1,  nights: 5, status: 'confirmed', guest: 1 },
    ];

    const TAX_RATE = 0.16;
    const SERVICE_RATE = 0.10;

    await withTransaction(async (connection) => {
        for (let index = 0; index < plans.length; index += 1) {
            const plan = plans[index];
            const room = rooms[index % rooms.length];
            if (!room) continue;

            const subtotal = Number(room.price_per_night) * plan.nights;
            const tax = Number((subtotal * TAX_RATE).toFixed(2));
            const service = Number((subtotal * SERVICE_RATE).toFixed(2));

            // Reference format matches the runtime generator: BK + 10 characters.
            const reference = `BK${String(Date.now()).slice(-6)}${String(index).padStart(4, '0')}`;

            await connection.execute(
                `INSERT INTO bookings
                   (booking_reference, user_id, room_id, check_in, check_out, guests, adults, children,
                    status, price_per_night, nights, subtotal, tax_amount, service_charge, total_amount, special_requests)
                 VALUES (:reference, :userId, :roomId, :checkIn, :checkOut, 2, 2, 0,
                    :status, :price, :nights, :subtotal, :tax, :service, :total, :requests)`,
                {
                    reference,
                    userId: guests[plan.guest],
                    roomId: room.id,
                    checkIn: dateIn(plan.offsetIn),
                    checkOut: dateIn(plan.offsetIn + plan.nights),
                    status: plan.status,
                    price: room.price_per_night,
                    nights: plan.nights,
                    subtotal,
                    tax,
                    service,
                    total: Number((subtotal + tax + service).toFixed(2)),
                    requests: null,
                },
            );
        }
    });

    console.log(`  ${plans.length} bookings`);
}

/** Removes all application data but keeps the schema. */
async function reset() {
    console.log('Clearing application data...');
    // Order matters: children before parents, since FKs are enforced.
    const tables = [
        'notifications', 'messages', 'conversation_participants', 'conversations',
        'reviews', 'invoices', 'payments', 'order_items', 'orders',
        'menu_items', 'menu_categories',
        'booking_guests', 'bookings',
        'room_amenities', 'rooms', 'amenities', 'room_types',
        'password_resets', 'email_verification_tokens', 'audit_logs', 'users',
        'role_permissions', 'permissions', 'roles',
    ];

    await execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
        await execute(`TRUNCATE TABLE ${table}`);
    }
    await execute('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`  ${tables.length} tables cleared`);
}

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('  HOTEL MANAGEMENT SYSTEM - DATABASE SEED');
    console.log('='.repeat(60) + '\n');

    const mode = process.argv.includes('--reset');
    if (mode) await reset();

    const roleIds = await seedRolesAndPermissions();
    const userIds = await seedUsers(roleIds);
    await seedRooms();
    await seedAmenities();
    await seedMenu();
    await seedReviews(userIds);
    await seedSampleBookings(userIds);

    console.log('\n' + '='.repeat(60));
    console.log('  Seed complete');
    console.log('='.repeat(60));
    console.log('\n  Demo accounts (development only):');
    console.log('  -----------------------------------');
    for (const account of DEMO_ACCOUNTS) {
        console.log(`  ${account.role.padEnd(18)} ${account.email.padEnd(26)} ${account.password}`);
    }
    console.log('\n  Run "npm run dev" and open ' + process.env.APP_URL + '\n');
}

// Only execute when run directly, so tests can import helpers safely.
// Comparing the resolved entry path against this file's own URL is exact,
// unlike matching on a filename substring.
const isDirectRun =
    process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main()
        .then(async () => {
            await closePool();
            process.exit(0);
        })
        .catch(async (error) => {
            console.error('\nSeed failed:', error);
            await closePool();
            process.exit(1);
        });
}

export { seedRolesAndPermissions, reset, main };