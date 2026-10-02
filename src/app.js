/**
 * src/app.js
 *
 * WHAT THIS MODULE DOES
 * Builds and exports the configured Express application.
 *
 * WHY IT EXISTS
 * Separating the app from the server means tests can import the app and make
 * requests without opening a real port, and the middleware order is defined
 * in one readable place.
 *
 * MIDDLEWARE ORDER IS SIGNIFICANT
 *   1. helmet          - security headers, must be first
 *   2. compression     - negotiate gzip before anything writes a body
 *   3. cors            - allow the dev frontend origin
 *   4. parsers         - parse JSON, forms and cookies
 *   5. static files    - serve the frontend
 *   6. rate limiting   - protect /api only, never static assets
 *   7. routes          - the API and the catch-all page routes
 *   8. 404 handler     - nothing matched
 *   9. error handler   - something threw
 *
 * Skipping or reordering these produces subtle bugs, for example a rate
 * limiter placed before static serving would throttle every image request.
 *
 * COMMUNICATION
 * Used by: src/server.js and tests/app.test.js.
 * Database tables used: none (middleware reads configuration only).
 */
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import env from './config/env.js';
import apiRoutes from './routes/index.js';
import { apiLimiter } from './middleware/rateLimit.middleware.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';

export function createApp() {
    const app = express();

    // Behind a reverse proxy (nginx, Heroku) this makes req.ip and
    // rate limiting use the real client address rather than the proxy's.
    app.set('trust proxy', 1);

    // 1. Security headers.
    app.use(
        helmet({
            /**
             * The Content Security Policy is configured explicitly rather than
             * left at the Helmet default, because the frontend legitimately
             * loads from several CDNs.
             *
             * WHY 'unsafe-inline' APPEARS HERE FOR SCRIPTS
             * Each page has a small inline `<script type="module">` block that
             * wires up that specific page. A strict policy without
             * 'unsafe-inline' blocks those blocks entirely, and without them no
             * page in the application works at all: no header, no data loading,
             * no forms.
             *
             * This is a real trade-off and worth being explicit about.
             * 'unsafe-inline' in script-src weakens the protection XSS
             * provides, so it should not be treated as free. The mitigations
             * that make it acceptable here are:
             *   - all page logic lives in separate .js modules served from
             *     this origin, where CSP still applies normally,
             *   - API data is inserted with textContent or escaped before it
             *     reaches the DOM, so a stored XSS payload cannot execute even
             *     if it were injected,
             *   - no third-party script other than the Tailwind CDN is loaded.
             *
             * The correct fix is to move every inline block into its own
             * external module file and drop 'unsafe-inline'. That is a
             * mechanical follow-up; until then the policy is deliberately
             * permissive for scripts and strict everywhere else.
             *
             * 'unsafe-eval' is required by the Tailwind CDN, which compiles
             * classes at runtime using Function(). It does not apply to the
             * production build path.
             */
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: [
                        "'self'",
                        'https://cdn.tailwindcss.com',
                        "'unsafe-inline'",
                        "'unsafe-eval'",
                    ],
                    styleSrc: [
                        "'self'",
                        "'unsafe-inline'",
                        'https://fonts.googleapis.com',
                        'https://cdnjs.cloudflare.com',
                    ],
                    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
                    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                    connectSrc: ["'self'"],
                    // Stops a page being framed, which enables clickjacking.
                    frameAncestors: ["'none'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'self'"],
                    formAction: ["'self'"],
                },
            },
            // Uploaded images are served by a controller rather than statically,
            // so cross-origin resource sharing is not needed here.
            crossOriginEmbedderPolicy: false,
            // Allows the page to be loaded from a CDN origin over HTTPS.
            crossOriginResourcePolicy: { policy: 'cross-origin' },
        }),
    );

    // 2. Compress responses.
    app.use(compression());

    // 3. CORS. The frontend is served by this same server in production, so
    // the default same-origin policy already covers it; this mainly helps when
    // a separate dev server runs on a different port.
    app.use(
        cors({
            origin: true,
            credentials: true, // required for the auth cookie to travel
        }),
    );

    // 4. Parse request bodies and cookies.
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    app.use(cookieParser(env.cookieSecret));

    // Request logging. 'dev' format is readable; production logs stay terse.
    if (!env.isProduction) {
        app.use(morgan('dev'));
    } else {
        app.use(morgan('combined'));
    }

    // 5. Static frontend.
    // Only the `public` directory is exposed. No source file, .env or upload
    // directory is reachable through this mapping.
    const publicDir = path.join(import.meta.dirname, '..', 'public');
    app.use(
        express.static(publicDir, {
            extensions: ['html'],
            maxAge: env.isProduction ? '7d' : 0,
        }),
    );

    // 6. API: rate limited, then routed.
    app.use('/api', apiLimiter, apiRoutes);

    // 7. Friendly page routes. These exist so navigation links stay short and
    // readable, and each serves the matching HTML file from public/.
    const pageRoutes = {
        '/login': '/pages/auth/login.html',
        '/register': '/pages/auth/register.html',
        '/forgot-password': '/pages/auth/forgot-password.html',
        '/reset-password': '/pages/auth/reset-password.html',
        '/verify-email': '/pages/auth/verify-email.html',
        '/dashboard': '/pages/guest/dashboard.html',
        '/rooms': '/pages/guest/rooms.html',
        '/restaurant': '/pages/guest/restaurant.html',
        '/bookings': '/pages/guest/bookings.html',
        '/orders': '/pages/guest/orders.html',
        '/payments': '/pages/guest/payments.html',
        '/reviews': '/pages/guest/reviews.html',
        '/messages': '/pages/guest/messages.html',
        '/profile': '/pages/guest/profile.html',
        '/notifications': '/pages/guest/notifications.html',
        '/invoices': '/pages/guest/invoices.html',
        '/admin': '/pages/admin/dashboard.html',
        '/admin/users': '/pages/admin/users.html',
        '/admin/rooms': '/pages/admin/rooms.html',
        '/admin/bookings': '/pages/admin/bookings.html',
        '/admin/orders': '/pages/admin/orders.html',
        '/admin/menu': '/pages/admin/menu.html',
        '/admin/payments': '/pages/admin/payments.html',
        '/admin/reviews': '/pages/admin/reviews.html',
        '/admin/reports': '/pages/admin/reports.html',
        '/admin/roles': '/pages/admin/roles.html',
        '/admin/messages': '/pages/admin/messages.html',
        '/admin/notifications': '/pages/admin/notifications.html',
        '/admin/audit': '/pages/admin/audit-logs.html',
        '/admin/settings': '/pages/admin/settings.html',
        '/reception': '/pages/staff/reception.html',
        '/restaurant-staff': '/pages/staff/restaurant.html',
        '/housekeeping': '/pages/staff/housekeeping.html',
    };

    for (const [routePath, filePath] of Object.entries(pageRoutes)) {
        app.get(routePath, (req, res) => {
            res.sendFile(filePath, { root: publicDir });
        });
    }

    // 8. Nothing matched.
    app.use(notFoundHandler);

    // 9. Something threw.
    app.use(errorHandler);

    return app;
}

export default createApp;