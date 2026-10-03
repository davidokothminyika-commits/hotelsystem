/**
 * public/js/pages/admin/settings.js
 *
 * WHAT THIS MODULE DOES
 * The hotel's runtime configuration and reference data, read only.
 *
 * WHY SETTINGS ARE NOT EDITABLE HERE
 * The configuration that governs this system lives in environment variables and
 * in the database, and changing either from a browser screen would mean shipping
 * secrets to the client and letting an unaudited request rewrite the settings
 * every request depends on. This screen therefore reports what is actually in
 * force, which is the thing an administrator genuinely needs when diagnosing a
 * deployment: is the payment provider the mock, which currency is live, is mail
 * enabled.
 *
 * WHY NO SECRET IS EVER DISPLAYED
 * The configuration endpoint returns only non-sensitive values. Nothing here
 * reads a token, a password or a connection string, and no value typed into the
 * browser can be sent back to change anything.
 *
 * COMMUNICATION
 * Page -> GET /api/payments/config   (provider, currency, methods, test cards)
 *      -> GET /api/menu/categories   (menu reference data)
 *      -> GET /api/rooms/types       (room type reference data)
 *      -> GET /api/admin/roles       (roles in use)
 * Database tables used: none directly; all four endpoints are read-only lookups.
 */
import { buildShell } from '../../components/shell.js';
import api from '../../api/api.js';
import { createElement, clear, showSkeleton, formatMoney } from '../../lib/dom.js';

const ROLES = ['admin'];

const shell = await buildShell({
    title: 'Settings',
    subtitle: 'Runtime configuration and reference data',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    const layout = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' });
    content.appendChild(layout);

    function panel(title, icon, body) {
        return createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: title }),
            ]),
            body,
        ]);
    }

    const paymentsBody = createElement('div', { class: 'p-4' });
    const roomTypesBody = createElement('div', { class: 'p-4' });
    const menuBody = createElement('div', { class: 'p-4' });
    const rolesBody = createElement('div', { class: 'p-4' });

    layout.append(
        panel('Payments', 'fa-credit-card', paymentsBody),
        panel('Room types', 'fa-bed', roomTypesBody),
        panel('Menu categories', 'fa-utensils', menuBody),
        panel('Roles in use', 'fa-shield-halved', rolesBody),
    );

    async function load() {
        for (const body of [paymentsBody, roomTypesBody, menuBody, rolesBody]) {
            showSkeleton(body, 3, 'h-8');
        }

        const [payments, roomTypes, categories, roles] = await Promise.all([
            api.get('/payments/config').catch(() => null),
            api.get('/rooms/types').catch(() => null),
            api.get('/menu/categories').catch(() => null),
            api.get('/admin/roles').catch(() => null),
        ]);

        renderPayments(payments?.data);
        renderRoomTypes(roomTypes?.data);
        renderCategories(categories?.data);
        renderRoles(roles?.data);
    }

    /** A label/value list, the repeated shape of every panel here. */
    function rows(container, entries) {
        clear(container);
        for (const [label, value] of entries) {
            const row = createElement('div', {
                class: 'flex items-center justify-between gap-3 py-1.5 border-b border-stone-100 last:border-0',
            });
            row.append(
                createElement('span', { class: 'text-sm text-stone-600 shrink-0', text: label }),
                createElement('span', { class: 'text-sm font-medium text-stone-900 text-right', text: value }),
            );
            container.appendChild(row);
        }
    }

    function renderPayments(config) {
        if (!config) {
            rows(paymentsBody, [['Status', 'Unavailable']]);
            return;
        }

        rows(paymentsBody, [
            ['Provider', config.providerName || config.provider],
            ['Provider id', config.provider],
            ['Currency', config.currency],
            ['Accepted methods', (config.methods || []).join(', ')],
            ['Mode', config.simulated ? 'Simulated (no real money moves)' : 'Live'],
            ['Registered providers', (config.providers || []).map((p) => p.name).join(', ')],
        ]);

        // The test cards are only meaningful when the gateway is simulated, so
        // they are listed conditionally rather than implying they apply.
        if (config.simulated && (config.testCards || []).length) {
            paymentsBody.appendChild(
                createElement('p', {
                    class: 'text-xs text-stone-500 mt-3 mb-1 font-medium',
                    text: 'Test cards',
                }),
            );
            for (const card of config.testCards) {
                const row = createElement('div', { class: 'flex items-center justify-between gap-3 py-1' });
                row.append(
                    createElement('span', { class: 'font-mono text-xs text-stone-700', text: card.number }),
                    createElement('span', { class: 'text-xs text-stone-500', text: card.label }),
                );
                paymentsBody.appendChild(row);
            }
        }
    }

    function renderRoomTypes(data) {
        const types = data?.roomTypes || data || [];
        if (!Array.isArray(types) || types.length === 0) {
            rows(roomTypesBody, [['Status', 'None configured']]);
            return;
        }

        clear(roomTypesBody);
        for (const type of types) {
            const row = createElement('div', {
                class: 'flex items-center justify-between gap-3 py-2 border-b border-stone-100 last:border-0',
            });
            const left = createElement('div', { class: 'min-w-0' });
            left.append(
                createElement('p', { class: 'text-sm font-medium text-stone-900', text: type.name }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: `${type.bedConfiguration || ''} · ${type.sizeSqm || '?'} m²`,
                }),
            );
            row.append(
                left,
                createElement('span', { class: 'text-sm text-stone-700', text: formatMoney(type.basePrice ?? type.price) }),
            );
            roomTypesBody.appendChild(row);
        }
    }

    function renderCategories(data) {
        const categories = data?.categories || [];
        rows(
            menuBody,
            categories.length
                ? categories.map((category) => [category.name, `${category.itemCount ?? 0} item(s)`])
                : [['Status', 'None configured']],
        );
    }

    function renderRoles(data) {
        const list = data?.roles || [];
        rows(
            rolesBody,
            list.length
                ? list.map((role) => [
                      role.name.replace('_', ' '),
                      `${role.userCount ?? 0} user(s), ${role.permissionCount ?? 0} permission(s)`,
                  ])
                : [['Status', 'Unavailable']],
        );
    }

    await load();
}
