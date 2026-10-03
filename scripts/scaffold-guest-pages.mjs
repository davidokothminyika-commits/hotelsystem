/**
 * scripts/scaffold-guest-pages.mjs
 *
 * WHAT THIS SCRIPT DOES
 * Writes the HTML shell for the remaining guest and auth pages.
 *
 * WHY IT EXISTS
 * The same reasoning as scaffold-pages.mjs: these pages are all a head block,
 * five placeholder elements and a module script, and only the title, the
 * description and the script path differ. Generating them keeps fourteen copies
 * of the same markup from drifting apart, and keeps the placeholder ids in step
 * with what components/shell.js expects.
 *
 * RUN
 *   node scripts/scaffold-guest-pages.mjs
 *
 * COMMUNICATION
 * Writes: public/pages/guest/*.html, public/pages/auth/forgot-password.html
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** [area, filename, title, description, module] */
const PAGES = [
    ['guest', 'orders', 'My orders', 'Track and manage your restaurant and room service orders.', '/js/pages/guest/orders.js'],
    ['guest', 'order-details', 'Order details', 'Full detail for one of your orders.', '/js/pages/guest/order-details.js'],
    ['guest', 'payments', 'Payments', 'Pay a balance and review your payment history.', '/js/pages/guest/payments.js'],
    ['guest', 'invoices', 'Invoices', 'Every invoice issued to your account.', '/js/pages/guest/invoices.js'],
    ['guest', 'restaurant', 'Restaurant', 'Browse the menu and order room service or pickup.', '/js/pages/guest/restaurant.js'],
    ['guest', 'room-details', 'Room details', 'Everything about one room type.', '/js/pages/guest/room-details.js'],
    ['guest', 'reviews', 'Reviews', 'Read what other guests said, and leave your own.', '/js/pages/guest/reviews.js'],
    ['guest', 'messages', 'Messages', 'Talk to the front desk.', '/js/pages/guest/messages.js'],
    ['guest', 'notifications', 'Notifications', 'Alerts about your stays, orders and payments.', '/js/pages/guest/notifications.js'],
    ['guest', 'profile', 'Profile', 'Your details and account security.', '/js/pages/guest/profile.js'],
    ['guest', 'settings', 'Settings', 'Preferences for your account.', '/js/pages/guest/settings.js'],
    ['auth', 'forgot-password', 'Forgot password', 'Request a link to reset your password.', '/js/pages/auth/forgot-password.js'],
];

/**
 * The shared shell.
 *
 * The five placeholder elements are filled by the page's module: the dashboard
 * pages call buildShell from components/shell.js, which resolves the session
 * and injects the sidebar and header. The auth pages have no shell, so they get
 * the minimal header and footer instead.
 */
function shell(title, description, module, { chrome = true } = {}) {
    const meta = description
        ? `    <meta name="description" content="${description}">\n`
        : '';

    const robots = chrome
        ? '    <meta name="robots" content="noindex">\n'
        : '';

    return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} | Aurelia Grand Hotel</title>
${meta}${robots}    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    <link rel="stylesheet" href="/css/app.css">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body class="h-full bg-stone-50">
    <a href="#page-content" class="skip-link">Skip to main content</a>

    <!-- Built by the page module: components/shell.js for dashboard pages, or
         components/header.js and components/footer.js for the auth pages. -->
    <div id="app-header"></div>
${chrome ? `    <div id="app-sidebar"></div>
    <div id="sidebar-overlay"></div>
    <div id="app-root"></div>
` : `    <div id="app-footer"></div>
`}    <div id="modal-root-slot"></div>

    <script type="module" src="${module}"></script>
</body>
</html>
`;
}

for (const [area, name, title, description, module] of PAGES) {
    const file = path.join(process.cwd(), 'public', 'pages', area, `${name}.html`);

    // The forgot-password page is a public auth screen: no dashboard chrome.
    const chrome = area === 'guest';
    await writeFile(file, shell(title, description, module, { chrome }), 'utf8');
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
