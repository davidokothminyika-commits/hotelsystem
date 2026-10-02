/**
 * src/server.js
 *
 * WHAT THIS MODULE DOES
 * Starts the HTTP server and performs boot checks. This is the file npm run
 * dev and npm start execute.
 *
 * WHY IT EXISTS
 * Startup concerns (database connectivity, port binding, graceful shutdown)
 * are different from application wiring, so they live here rather than in
 * app.js.
 *
 * COMMUNICATION
 * Reads: config/env.js, config/db.js, app.js
 * Database tables used: none directly (runs a connectivity ping).
 */
import env from './config/env.js';
import { createApp } from './app.js';
import { testConnection, closePool } from './config/db.js';

async function start() {
    // Fail fast and loudly. A misconfigured database should stop the process
    // with a clear message rather than accepting requests that all fail.
    try {
        await testConnection();
        console.log(`[db] Connected to ${env.db.database} at ${env.db.host}:${env.db.port}`);
    } catch (error) {
        console.error('[db] Connection failed:', error.message);
        console.error('     Check your .env settings and that the MySQL server is running.');
        process.exit(1);
    }

    if (!env.isProduction) {
        console.warn(
            `[config] Running in development mode. JWT_SECRET ${env.jwt.secret.startsWith('dev-only') ? 'is using the INSECURE DEFAULT' : 'is set'}.`,
        );
    }

    const app = createApp();
    const server = app.listen(env.port, () => {
        console.log('');
        console.log('  ' + env.appName);
        console.log('  ----------------------------------------------');
        console.log(`  Environment : ${env.nodeEnv}`);
        console.log(`  Server      : http://localhost:${env.port}`);
        console.log(`  Mail        : ${env.mail.enabled ? 'SMTP enabled' : 'console only (development)'}`);
        console.log('  ----------------------------------------------');
        console.log('');
    });

    /**
     * Graceful shutdown: stop accepting connections, let in-flight requests
     * finish, then close the connection pool.
     */
    async function shutdown(signal) {
        console.log(`\n[server] ${signal} received, shutting down...`);
        server.close(async () => {
            await closePool();
            console.log('[server] Shutdown complete');
            process.exit(0);
        });

        // Do not hang forever if a connection refuses to close.
        setTimeout(() => {
            console.error('[server] Forcing shutdown after timeout');
            process.exit(1);
        }, 10_000).unref();
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // An unhandled rejection means a promise failed with no handler. Log it
    // loudly instead of exiting silently, but do not crash the process.
    process.on('unhandledRejection', (reason) => {
        console.error('[server] Unhandled promise rejection:', reason);
    });
}

start();