/**
 * src/routes/index.js
 *
 * WHAT THIS MODULE DOES
 * Mounts every API router under a single /api prefix.
 *
 * WHY IT EXISTS
 * The route table of contents belongs in one file. A developer can see the
 * entire API surface without opening ten files, and adding a feature means
 * adding exactly one import and one line here.
 *
 * URL STRUCTURE
 *   /api/auth/*        -> auth.routes.js
 *   /api/users/*       -> users.routes.js
 *   /api/rooms/*       -> rooms.routes.js
 *   ...
 * Each router declares only its own sub-paths.
 *
 * COMMUNICATION
 * Used by: src/app.js, mounted at /api.
 */
import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './users.routes.js';
import adminRoutes from './admin.routes.js';
import roomRoutes from './rooms.routes.js';
import bookingRoutes from './bookings.routes.js';
import menuRoutes from './menu.routes.js';
import orderRoutes from './orders.routes.js';

const router = Router();

/**
 * Lightweight health check. Useful for confirming the server and database are
 * both alive before opening the application.
 */
router.get('/health', async (req, res) => {
    res.json({
        success: true,
        message: 'Hotel Management System API is running',
        data: {
            status: 'healthy',
            environment: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
        },
    });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/rooms', roomRoutes);
router.use('/bookings', bookingRoutes);
router.use('/menu', menuRoutes);
router.use('/orders', orderRoutes);

// Mounted without a role guard here on purpose: the guard lives inside
// admin.routes.js as `router.use(requireRole('admin'))`, so every route added
// to that file is protected automatically.
router.use('/admin', adminRoutes);

export default router;