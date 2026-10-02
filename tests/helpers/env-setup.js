/**
 * tests/helpers/env-setup.js
 *
 * WHAT THIS MODULE DOES
 * Sets NODE_ENV=test before any application module is imported.
 *
 * WHY THIS EXISTS
 * The npm script `NODE_ENV=test node --test ...` relies on shell syntax that
 * does not work on Windows cmd.exe. Setting the variable in JavaScript keeps
 * `npm test` portable across platforms.
 *
 * WHY THE IMPORT ORDER MATTERS
 * ES modules are evaluated depth-first in the order they are imported. This
 * module must therefore be the FIRST import in every test file, before
 * anything that pulls in config/env.js, because env.js reads NODE_ENV once at
 * module load time and freezes the result.
 */
process.env.NODE_ENV = 'test';

export default 'test';