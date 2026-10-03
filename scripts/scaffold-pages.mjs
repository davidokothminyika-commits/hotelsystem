/**
 * scripts/scaffold-pages.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Writes the HTML shell for each admin page.
 *
 * WHY IT EXISTS
 * Fifteen pages share a byte-identical shell that differs only in its <title>
 * and its module path. Copy-pasting that fifteen times is how one of them ends
 * up pointing at the wrong script, so it is generated instead. The page logic
 * lives in separate hand-written modules; only the boilerplate is scripted.
 *
 * RUN
 *   node scripts/scaffold-pages.mjs
 *
 * COMMUNICATION
 * Writes: public/pages/admin/*.html
 * Reads:  the page list below.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** [filename, title, module path] for every admin page. */
const PAGES = [
    ['dashboard', 'Dashboard', '/js/pages/admin/dashboard.js'],
    ['bookings', 'Bookings', '/js/pages/admin/bookings.js'],
    ['rooms', 'Rooms', '/js/pages/admin/rooms.js'],
    ['orders', 'Orders', '/js/pages/admin/orders.js'],
    ['menu', 'Menu', '/js/pages/admin/menu.js'],
    ['payments', 'Payments', '/js/pages/admin/payments.js'],
    ['invoices', 'Invoices', '/js/pages/admin/invoices.js'],
    ['users', 'Users', '/js/pages/admin/users.js'],
    ['roles', 'Roles & permissions', '/js/pages/admin/roles.js'],
    ['reviews', 'Reviews', '/js/pages/admin/reviews.js'],
    ['notifications', 'Notifications', '/js/pages/admin/notifications.js'],
    ['audit-logs', 'Audit log', '/js/pages/admin/audit-logs.js'],
    ['reports', 'Reports', '/js/pages/admin/reports.js'],
    ['settings', 'Settings', '/js/pages/admin/settings.js'],
];

/**
 * The shared shell.
 *
 * The placeholder elements are filled by public/js/components/shell.js: it
 * resolves the session, loads the sidebar and header components into them and
 * builds the content region. Keeping them empty here is what lets the shell be
 * the single place that decides what a signed-in page looks like.
 */
function shell(title, module) {
    return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | Aurelia Grand Hotel</title>
    <meta name="robots" content="noindex">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    <link rel="stylesheet" href="/css/app.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body class="h-full bg-stone-50">
    <a href="#page-content" class="skip-link">Skip to main content</a>

    <!-- The dashboard shell is built by public/js/components/shell.js, which
         resolves the session and moves the sidebar into the layout. -->
    <div id="app-sidebar"></div>
    <div id="sidebar-overlay"></div>
    <div id="app-root"></div>
    <div id="app-header"></div>
    <div id="modal-root-slot"></div>

    <script type="module" src="${module}"></script>
</body>
</html>
`;
}

for (const [name, title, module] of PAGES) {
    const file = path.join(process.cwd(), 'public', 'pages', 'admin', `${name}.html`);
    await writeFile(file, shell(title, module), 'utf8');
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
