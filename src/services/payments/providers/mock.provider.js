/**
 * src/services/payments/providers/mock.provider.js
 *
 * WHAT THIS MODULE DOES
 * A simulated payment provider. It behaves like a real gateway without moving
 * money: it authorises, declines or cancels a charge and returns the same
 * result shape a real provider would, so nothing above this layer changes when
 * a live provider is swapped in.
 *
 * WHY IT EXISTS
 * The system must be demonstrable on a laptop with no merchant account and no
 * API keys. Rather than faking payment inside the order and booking services,
 * the simulation sits behind a provider interface. That keeps the business
 * rules honest: they hold the same assumptions about pending, completed and
 * failed payments that they would hold against a real gateway.
 *
 * HOW DECLINES ARE TRIGGERED
 * The caller passes an `outcome` hint when the developer deliberately wants a
 * failure. Card numbers ending 0002 always decline and those ending 9995 are
 * declined for insufficient funds, matching the well known test-card
 * convention, so the decline path can also be exercised by simply typing a
 * number.
 *
 * COMMUNICATION
 * Imported by: src/services/payments/index.js (the provider registry)
 * Used by: payment.service.js through the provider interface
 * Database tables used: none. Persisting the result is the service's job,
 * which keeps this module free of SQL and easy to test in isolation.
 */

/** Amounts are held in minor units to avoid floating point drift. */
function toMinorUnits(amount) {
    return Math.round(Number(amount) * 100);
}

function fromMinorUnits(minor) {
    return Number((minor / 100).toFixed(2));
}

/** Returns the final four digits only, so a full card number is never logged. */
function lastFourOf(cardNumber) {
    const digits = String(cardNumber || '').replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * A display-only mask, for a receipt that shows the card a guest paid with.
 * It is never stored: the service persists `lastFour` instead, which is the
 * only part of the number that has any meaning once the charge is done.
 */
function maskCardNumber(cardNumber) {
    const lastFour = lastFourOf(cardNumber);
    return lastFour ? `**** **** **** ${lastFour}` : '****';
}

/**
 * Deterministic reference with a short random tail.
 * The random part matters because two payments of the same amount in the same
 * millisecond must still get distinct references.
 */
function buildReference(prefix) {
    const stamp = Date.now().toString(36).toUpperCase();
    const noise = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `${prefix}-${stamp}-${noise}`;
}

/**
 * Runs a Luhn check.
 * A real gateway rejects a mistyped card number before authorising. Checking
 * locally means the developer gets the error immediately rather than after a
 * round trip, and it catches the common typo of a single wrong digit.
 */
export function passesLuhn(cardNumber) {
    const digits = String(cardNumber || '').replace(/\D/g, '');
    if (digits.length < 12 || digits.length > 19) return false;

    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let digit = Number(digits[i]);
        if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}

/** The provider contract every implementation must satisfy. */
export const mockProvider = {
    name: 'mock',
    displayName: 'Simulated Gateway',

    /** Card brands recognised for display purposes only. */
    detectBrand(cardNumber) {
        const digits = String(cardNumber || '').replace(/\D/g, '');
        if (/^4/.test(digits)) return 'visa';
        if (/^5[1-5]/.test(digits) || /^2[2-7]/.test(digits)) return 'mastercard';
        if (/^3[47]/.test(digits)) return 'amex';
        if (/^6(?:011|5)/.test(digits)) return 'discover';
        return 'card';
    },

    /**
     * Authorises a charge.
     *
     * @param {object} charge
     * @param {number} charge.amount          Total in major currency units.
     * @param {string} charge.currency
     * @param {string} charge.method          card | mobile_money | cash
     * @param {string} [charge.cardNumber]
     * @param {string} [charge.mobileNumber]
     * @param {string} [charge.outcome]       Intentional success | failure | cancelled
     * @returns {Promise<object>} A provider-neutral result.
     */
    async charge({ amount, currency = 'USD', method, cardNumber, mobileNumber, outcome }) {
        const minor = toMinorUnits(amount);

        // A zero or negative amount is a programming error, not a decline.
        // Failing loudly here is better than recording a completed payment
        // for nothing, which would corrupt the revenue report.
        if (!Number.isFinite(minor) || minor <= 0) {
            throw new Error('A payment amount must be greater than zero');
        }

        // Cash is collected at the property, so it is never declined online.
        // It completes immediately because there is no authorisation step.
        if (method === 'cash') {
            return {
                status: 'completed',
                reference: buildReference('CASH'),
                transactionId: `cash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: fromMinorUnits(minor),
                currency,
                method,
                brand: null,
                lastFour: null,
                message: 'Payment recorded as cash, collect on arrival',
                // Cash is settled at the desk rather than settled online, so
                // the dashboard reports it as outstanding until then.
                requiresSettlement: true,
            };
        }

        if (method === 'mobile_money') {
            const digits = String(mobileNumber || '').replace(/\D/g, '');
            if (digits.length < 9) {
                return {
                    status: 'failed',
                    reference: buildReference('MM'),
                    transactionId: `mm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    amount: fromMinorUnits(minor),
                    currency,
                    method,
                    brand: null,
                    lastFour: null,
                    message: 'Enter a valid mobile money number',
                    failureCode: 'INVALID_MOBILE_NUMBER',
                };
            }

            if (outcome === 'cancel') {
                return {
                    status: 'cancelled',
                    reference: buildReference('MM'),
                    transactionId: `mm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    amount: fromMinorUnits(minor),
                    currency,
                    method,
                brand: null,
                lastFour: digits.slice(-4),
                maskedNumber: `****${digits.slice(-4)}`,
                message: 'Payment cancelled before confirmation',
                };
            }

            if (outcome === 'failure') {
                return {
                    status: 'failed',
                    reference: buildReference('MM'),
                    transactionId: `mm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    amount: fromMinorUnits(minor),
                    currency,
                    method,
                brand: null,
                lastFour: digits.slice(-4),
                maskedNumber: `****${digits.slice(-4)}`,
                message: 'The mobile money request was rejected. Check your balance and try again.',
                    failureCode: 'INSUFFICIENT_FUNDS',
                };
            }

            return {
                status: 'completed',
                reference: buildReference('MM'),
                transactionId: `mm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: fromMinorUnits(minor),
                currency,
                method,
            brand: null,
            lastFour: digits.slice(-4),
            maskedNumber: `****${digits.slice(-4)}`,
            message: 'Mobile money payment confirmed',
            };
        }

        // ---- Card -----------------------------------------------------------

        const digits = String(cardNumber || '').replace(/\D/g, '');

        if (!passesLuhn(digits)) {
            return {
                status: 'failed',
                reference: buildReference('PAY'),
                transactionId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: fromMinorUnits(minor),
                currency,
                method,
                brand: this.detectBrand(digits),
                lastFour: lastFourOf(digits),
                maskedNumber: maskCardNumber(digits),
                message: 'That card number is not valid. Check the digits and try again.',
                failureCode: 'INVALID_CARD_NUMBER',
            };
        }

        if (outcome === 'cancel') {
            return {
                status: 'cancelled',
                reference: buildReference('PAY'),
                transactionId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: fromMinorUnits(minor),
                currency,
                method,
                brand: this.detectBrand(digits),
                lastFour: lastFourOf(digits),
                maskedNumber: maskCardNumber(digits),
                message: 'Payment cancelled',
            };
        }

        // The industry test cards for the two decline reasons. These are checked
        // independently, not nested: testing the insufficient funds suffix
        // inside the generic decline branch made it unreachable, so the 9995
        // card was silently approved and a guest who was told their payment
        // failed for lack of funds was actually charged.
        const isTestDecline = digits.endsWith('0002');
        const isTestInsufficient = digits.endsWith('9995');

        if (outcome === 'failure' || isTestDecline || isTestInsufficient) {
            const insufficient = outcome === 'insufficient_funds' || isTestInsufficient;
            return {
                status: 'failed',
                reference: buildReference('PAY'),
                transactionId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                amount: fromMinorUnits(minor),
                currency,
                method,
                brand: this.detectBrand(digits),
                lastFour: lastFourOf(digits),
                maskedNumber: maskCardNumber(digits),
                message: insufficient
                    ? 'The card was declined for insufficient funds.'
                    : 'The card was declined by the issuing bank.',
                failureCode: insufficient ? 'INSUFFICIENT_FUNDS' : 'CARD_DECLINED',
            };
        }

        return {
            status: 'completed',
            reference: buildReference('PAY'),
            transactionId: `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            amount: fromMinorUnits(minor),
            currency,
            method,
            brand: this.detectBrand(digits),
            lastFour: lastFourOf(digits),
            maskedNumber: maskCardNumber(digits),
            message: 'Payment approved',
        };
    },

    /**
     * Reverses a completed payment.
     *
     * A real refund is not instantaneous, so this returns `processing` rather
     * than `completed`. The UI therefore shows a refund as in flight instead
     * of claiming money has already moved.
     */
    async refund({ paymentReference, amount }) {
        const minor = amount === undefined ? null : toMinorUnits(amount);
        if (minor !== null && minor <= 0) {
            throw new Error('A refund amount must be greater than zero');
        }

        return {
            status: 'processing',
            reference: buildReference('REF'),
            transactionId: `rf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            originalReference: paymentReference,
            amount: minor === null ? null : fromMinorUnits(minor),
            message: 'Refund accepted and is being processed',
        };
    },
};

export default mockProvider;
