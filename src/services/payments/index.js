/**
 * src/services/payments/index.js
 *
 * WHAT THIS MODULE DOES
 * The payment provider registry. It resolves which provider handles a request
 * and exposes the provider interface to the rest of the application.
 *
 * WHY IT EXISTS
 * Services must not know which provider is in use. Booking and order code call
 * `charge()` here, never `mockProvider.charge()` directly, so introducing a
 * real gateway later means adding one file and changing one line of config
 * rather than editing every call site.
 *
 * THE CONTRACT
 * A provider is an object with three methods:
 *   charge({ amount, currency, method, ... }) -> result
 *   refund({ paymentReference, amount })      -> result
 *   name, displayName
 * A result is always shaped:
 *   { status, reference, transactionId, amount, currency, message, ... }
 * where status is one of pending | processing | completed | failed |
 * cancelled | refunded. Providers never write to the database; that is the
 * service's responsibility, which is what allows a provider to be swapped
 * without touching persistence.
 *
 * COMMUNICATION
 * Imported by: services/payment.service.js
 * Holds: providers/mock.provider.js (and any provider added later)
 */
import env from '../../config/env.js';
import mockProvider from './providers/mock.provider.js';

/** Every provider this build knows how to reach. */
const providers = new Map([[mockProvider.name, mockProvider]]);

/**
 * Returns the active provider.
 *
 * Selection is configuration driven rather than hard coded, so switching to a
 * real gateway is a .env change. An unknown name fails loudly at call time
 * instead of silently falling back to the mock, because silently simulating a
 * real payment would be the worst possible failure mode here.
 */
export function getProvider(name = env.paymentProvider) {
    const provider = providers.get(name);
    if (!provider) {
        throw new Error(
            `Unknown payment provider "${name}". Available: ${[...providers.keys()].join(', ')}`,
        );
    }
    return provider;
}

/** Registers an additional provider. Used by tests and future integrations. */
export function registerProvider(provider) {
    if (!provider?.name) throw new Error('A payment provider must expose a name');
    providers.set(provider.name, provider);
    return provider;
}

export function listProviders() {
    return [...providers.values()].map((provider) => ({
        name: provider.name,
        displayName: provider.displayName,
    }));
}

/**
 * Charges a customer through the configured provider.
 * This is the only function the rest of the application calls.
 */
export async function charge(request) {
    return getProvider().charge(request);
}

export async function refund(request) {
    return getProvider().refund(request);
}

/** Test cards documented in the UI so the decline paths can be exercised. */
export const TEST_CARDS = Object.freeze([
    {
        number: '4242424242424242',
        label: 'Successful payment',
        outcome: 'completed',
    },
    {
        number: '4000000000000002',
        label: 'Declined by the bank',
        outcome: 'failed',
    },
    {
        number: '4000000000009995',
        label: 'Insufficient funds',
        outcome: 'failed',
    },
    {
        number: '4000000000000119',
        label: 'Processing error',
        outcome: 'failed',
    },
]);

export { mockProvider };
