/**
 * public/js/pages/guest/settings.js
 *
 * WHAT THIS MODULE DOES
 * Display and account preferences for the guest.
 *
 * WHY THESE PREFERENCES LIVE IN LOCAL STORAGE
 * They are per-device choices about how the interface looks, not facts about the
 * guest that the hotel needs to know. Putting them in the database would mean
 * changing the sidebar collapsed state on a phone also collapsed it on a desk
 * two rooms away. localStorage is the correct scope, and it means these settings
 * work even before the profile request returns.
 *
 * WHY PASSWORD AND EMAIL ARE LINKS, NOT FIELDS
 * Changing either requires the current password and a confirmation. Putting them
 * on a preferences screen would invite someone to change a password from a
 * shared device without thinking about it, so this page links to the profile
 * page where the confirmation is part of the flow.
 *
 * COMMUNICATION
 * Page -> none. Every control here is local to the browser.
 * Database tables used: none.
 */
import { buildShell } from '../../components/shell.js';
import { createElement } from '../../lib/dom.js';

/** Preference keys, namespaced so they cannot collide with anything else. */
const KEYS = {
    density: 'hotel.density',
    reduceMotion: 'hotel.reduceMotion',
    emailBookingUpdates: 'hotel.emailBookingUpdates',
    emailOrderUpdates: 'hotel.emailOrderUpdates',
    emailPromotions: 'hotel.emailPromotions',
};

const DEFAULTS = {
    density: 'comfortable',
    reduceMotion: false,
    emailBookingUpdates: true,
    emailOrderUpdates: true,
    emailPromotions: false,
};

/**
 * Reads a preference, falling back to the default.
 * Anything unreadable is treated as absent rather than thrown, because a
 * corrupted localStorage entry should not break the settings page.
 */
function readPreference(key) {
    try {
        const stored = localStorage.getItem(KEYS[key]);
        return stored === null ? DEFAULTS[key] : JSON.parse(stored);
    } catch {
        return DEFAULTS[key];
    }
}

function writePreference(key, value) {
    try {
        localStorage.setItem(KEYS[key], JSON.stringify(value));
    } catch {
        // Private browsing can refuse writes. The preference then lasts for this
        // page only, which is a reasonable degradation.
    }
}

const shell = await buildShell({
    title: 'Settings',
    subtitle: 'How the site behaves for you',
});

if (shell?.content) {
    const { content } = shell;

    const layout = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6 items-start' });
    content.appendChild(layout);

    // =====================================================================
    // Appearance
    // =====================================================================
    const appearance = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
    });
    appearance.appendChild(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
            createElement('h2', { class: 'font-semibold text-stone-900 flex items-center gap-2' }, [
                createElement('i', { class: 'fa-solid fa-sliders text-amber-600', 'aria-hidden': 'true' }),
                createElement('span', { text: 'Appearance' }),
            ]),
        ]),
    );

    const appearanceBody = createElement('div', { class: 'p-4 space-y-4' });
    appearance.appendChild(appearanceBody);

    // Compact density is applied immediately, so the effect of the choice is
    // visible without navigating away from the control that made it.
    const densityField = createElement('div');
    densityField.appendChild(
        createElement('label', { class: 'form-label', for: 'pref-density', text: 'Row density' }),
    );
    const densitySelect = createElement('select', { class: 'form-select', id: 'pref-density' });
    for (const [value, label] of [
        ['comfortable', 'Comfortable'],
        ['compact', 'Compact'],
    ]) {
        densitySelect.appendChild(createElement('option', { value, text: label }));
    }
    densitySelect.value = readPreference('density');
    densityField.appendChild(densitySelect);
    appearanceBody.appendChild(densityField);

    const motionToggle = toggleRow({
        label: 'Reduce motion',
        hint: 'Turns off animated transitions across the site.',
        checked: readPreference('reduceMotion'),
        onChange: (value) => {
            writePreference('reduceMotion', value);
            document.documentElement.classList.toggle('reduce-motion', value);
        },
    });
    appearanceBody.appendChild(motionToggle.element);

    layout.appendChild(appearance);

    // =====================================================================
    // Email preferences
    // =====================================================================
    const email = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
    });
    email.appendChild(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
            createElement('h2', { class: 'font-semibold text-stone-900 flex items-center gap-2' }, [
                createElement('i', { class: 'fa-solid fa-envelope text-amber-600', 'aria-hidden': 'true' }),
                createElement('span', { text: 'Email updates' }),
            ]),
        ]),
    );

    const emailBody = createElement('div', { class: 'p-4 space-y-4' });
    email.appendChild(emailBody);

    emailBody.appendChild(
        createElement('p', {
            class: 'text-xs text-stone-500',
            text: 'Booking confirmations and receipts are always emailed regardless of these preferences.',
        }),
    );

    for (const [key, label, hint] of [
        ['emailBookingUpdates', 'Booking updates', 'Arrival reminders and changes to your reservation.'],
        ['emailOrderUpdates', 'Order updates', 'When a room service or restaurant order is ready.'],
        ['emailPromotions', 'Offers and news', 'Occasional offers from the hotel.'],
    ]) {
        const row = toggleRow({
            label,
            hint,
            checked: readPreference(key),
            onChange: (value) => writePreference(key, value),
        });
        emailBody.appendChild(row.element);
    }

    layout.appendChild(email);

    // =====================================================================
    // Account
    // =====================================================================
    const account = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm lg:col-span-2',
    });
    account.appendChild(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
            createElement('h2', { class: 'font-semibold text-stone-900 flex items-center gap-2' }, [
                createElement('i', { class: 'fa-solid fa-user-gear text-amber-600', 'aria-hidden': 'true' }),
                createElement('span', { text: 'Account' }),
            ]),
        ]),
    );

    const accountBody = createElement('div', { class: 'p-4' });
    account.appendChild(accountBody);

    for (const [href, icon, title, description] of [
        ['/pages/guest/profile.html', 'fa-user', 'Profile', 'Your name, phone number and photo.'],
        ['/pages/guest/reviews.html', 'fa-star', 'Reviews', 'Read and write reviews of your stay.'],
        ['/pages/guest/messages.html', 'fa-comments', 'Messages', 'Talk to the front desk.'],
    ]) {
        accountBody.appendChild(
            createElement('a', {
                href,
                class: 'flex items-center gap-3 p-3 rounded-lg border border-stone-200 hover:bg-stone-50 transition mb-2',
            }, [
                createElement('i', { class: `fa-solid ${icon} text-stone-400 w-5 text-center`, 'aria-hidden': 'true' }),
                createElement('div', { class: 'min-w-0 flex-1' }, [
                    createElement('p', { class: 'text-sm font-medium text-stone-900', text: title }),
                    createElement('p', { class: 'text-xs text-stone-500', text: description }),
                ]),
                createElement('i', { class: 'fa-solid fa-chevron-right text-stone-300', 'aria-hidden': 'true' }),
            ]),
        );
    }

    layout.appendChild(account);

    // Apply the saved preferences now, so arriving here already looks right.
    densitySelect.addEventListener('change', () => {
        writePreference('density', densitySelect.value);
        document.documentElement.classList.toggle('density-compact', densitySelect.value === 'compact');
    });
    document.documentElement.classList.toggle(
        'density-compact',
        readPreference('density') === 'compact',
    );
    document.documentElement.classList.toggle('reduce-motion', readPreference('reduceMotion'));
}

/**
 * A labelled switch.
 *
 * Uses a real checkbox rather than a styled div so it is reachable by keyboard
 * and announced correctly without any extra ARIA.
 */
function toggleRow({ label, hint, checked, onChange }) {
    const element = createElement('div', { class: 'flex items-start justify-between gap-3' });

    const text = createElement('label', { class: 'min-w-0 cursor-pointer' });
    text.append(
        createElement('span', { class: 'block text-sm font-medium text-stone-900', text: label }),
        createElement('span', { class: 'block text-xs text-stone-500 mt-0.5', text: hint }),
    );

    const input = createElement('input', { type: 'checkbox', class: 'mt-1 h-4 w-4 shrink-0' });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));

    // Clicking the label should toggle the switch, which it does by default
    // only if the input is inside the label, so the id is tied here instead.
    const id = `pref-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
    input.id = id;
    text.setAttribute('for', id);

    element.append(text, input);
    return { element, input };
}
