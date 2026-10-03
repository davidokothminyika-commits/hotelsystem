/**
 * public/js/pages/guest/restaurant.js
 *
 * WHAT THIS MODULE DOES
 * The restaurant menu: browse by category, build a basket, and place an order for
 * pickup or room delivery.
 *
 * WHY THE BASKET LIVES IN MEMORY
 * It is deliberately not persisted. A basket that survived a reload would need a
 * server-side cart with its own lifecycle, and a stale cart that reappears a
 * week later is worse than an empty one. Losing the basket on refresh is the
 * honest behaviour for a short ordering flow.
 *
 * WHY DELIVERY IS OFFERED ONLY WHEN IN HOUSE
 * Room delivery to an address the hotel does not have is meaningless, so the
 * fulfilment choice is driven by whether the guest currently has a room. The
 * server enforces this too; the page just avoids offering the impossible.
 *
 * COMMUNICATION
 * Page -> GET  /api/menu/categories   (the filter)
 *      -> GET  /api/menu              (the items)
 *      -> GET  /api/bookings          (is the guest in house?)
 *      -> POST /api/orders            (placing the order)
 * Database tables used: menu_items, menu_categories, orders, order_items, bookings
 */
import { buildShell } from '../../components/shell.js';
import { menuItemCard } from '../../components/cards.js';
import { openModal, confirmDialog } from '../../components/modal.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatMoney,
    debounce,
    todayInputValue,
} from '../../lib/dom.js';

const shell = await buildShell({
    title: 'Restaurant',
    subtitle: 'Order pickup or room service',
});

if (shell?.content) {
    const { content } = shell;

    /** lineId -> { item, quantity, instructions }. */
    const basket = new Map();

    let categories = [];
    let activeCategory = '';
    let inHouseBooking = null;

    // =====================================================================
    // Layout
    // =====================================================================
    const layout = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start' });
    content.appendChild(layout);

    const menuColumn = createElement('div', { class: 'min-w-0' });
    const basketColumn = createElement('div', { class: 'lg:sticky lg:top-4' });
    layout.append(menuColumn, basketColumn);

    // ---- Filters ----------------------------------------------------------
    const filterBar = createElement('div', { class: 'flex flex-wrap gap-2 mb-4' });
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter the menu by category');

    const searchInput = createElement('input', {
        type: 'search',
        class: 'form-input',
        placeholder: 'Search the menu...',
        'aria-label': 'Search the menu',
    });
    searchInput.addEventListener(
        'input',
        debounce(() => loadItems(searchInput.value.trim() || undefined), 350),
    );
    const searchWrap = createElement('div', { class: 'flex-1 min-w-[200px] mb-2' });
    searchWrap.appendChild(searchInput);

    menuColumn.append(searchWrap, filterBar);

    const itemList = createElement('div', { id: 'menu-items', class: 'space-y-4' });
    menuColumn.appendChild(itemList);

    // ---- Basket panel -----------------------------------------------------
    // Declared before the panel that uses it. A `let` is in its temporal dead
    // zone until the declaration runs, so calling the factory any earlier
    // throws "Cannot access before initialization" and the page stays blank.
    let countBadge = null;
    function basketCountBadge() {
        // The id matters: several other badges on this page use the same
        // neutral style, so anything reading "how many dishes" needs a
        // selector that cannot match one of them.
        countBadge = createElement('span', { id: 'basket-count', class: 'badge badge-neutral', text: '0' });
        return countBadge;
    }

    const basketPanel = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
    });
    basketPanel.appendChild(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center justify-between' }, [
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Your order' }),
            basketCountBadge(),
        ]),
    );
    const basketBody = createElement('div', { class: 'p-4' });
    basketPanel.appendChild(basketBody);
    basketColumn.appendChild(basketPanel);

    // =====================================================================
    // Data
    // =====================================================================
    async function loadCategories() {
        try {
            const result = await api.get('/menu/categories');
            categories = result?.data?.categories || [];
        } catch {
            categories = [];
        }

        clear(filterBar);
        for (const category of [{ id: '', name: 'Everything', itemCount: null }, ...categories]) {
            filterBar.appendChild(
                createElement('button', {
                    type: 'button',
                    class: activeCategory === category.id ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
                    text: category.itemCount === null ? category.name : `${category.name} (${category.itemCount})`,
                    'aria-pressed': String(activeCategory === category.id),
                    'data-category': category.id,
                    onclick: () => {
                        activeCategory = category.id;
                        for (const button of filterBar.querySelectorAll('[data-category]')) {
                            const active = button.dataset.category === activeCategory;
                            button.className = active ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
                            button.setAttribute('aria-pressed', String(active));
                        }
                        loadItems();
                    },
                }),
            );
        }
    }

    async function loadItems(search) {
        showSkeleton(itemList, 4, 'h-28');

        try {
            const result = await api.get('/menu', {
                query: {
                    limit: 60,
                    category: activeCategory || undefined,
                    search,
                },
            });

            const items = result?.data || [];
            clear(itemList);

            if (items.length === 0) {
                showEmptyState(itemList, {
                    title: 'Nothing on the menu matches',
                    message: 'Try another category or clear the search.',
                    icon: 'fa-utensils',
                });
                return;
            }

            for (const item of items) {
                // A sold-out dish is shown rather than hidden, so the guest
                // understands why it is missing from what they can order.
                if (!item.isAvailable) {
                    itemList.appendChild(unavailableCard(item));
                    continue;
                }
                itemList.appendChild(menuItemCard(item, (dish) => addToBasket(dish)));
            }
        } catch (error) {
            clear(itemList);
            showEmptyState(itemList, {
                title: 'Could not load the menu',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function unavailableCard(item) {
        const card = createElement('article', {
            class: 'card p-4 opacity-60 flex items-center justify-between gap-3',
        });
        card.append(
            createElement('div', { class: 'min-w-0' }, [
                createElement('p', { class: 'font-medium text-stone-700', text: item.name }),
                createElement('p', { class: 'text-xs text-stone-500', text: 'Sold out today' }),
            ]),
            createElement('span', { class: 'badge badge-neutral', text: 'Unavailable' }),
        );
        return card;
    }

    async function loadStayContext() {
        try {
            const result = await api.get('/bookings', { query: { limit: 50 } });
            const bookings = result?.data || [];
            inHouseBooking = bookings.find(isCurrentlyStaying) || null;
        } catch {
            inHouseBooking = null;
        }
    }

    /**
     * Whether the guest is actually in this room right now.
     *
     * This mirrors the server's own rule for room delivery, which rejects an
     * order unless the guest has a booking that is checked in, or is confirmed
     * or pending with today inside the date range. A checked out booking does
     * not qualify: the guest has left, so there is nobody to hand the tray to.
     * Predicting it here means the page never offers a fulfilment the API will
     * refuse.
     */
    function isCurrentlyStaying(booking) {
        if (!booking?.roomId) return false;
        if (booking.status === 'checked_in') return true;
        if (!['confirmed', 'pending'].includes(booking.status)) return false;

        const today = todayInputValue();
        const checkIn = String(booking.checkIn || '').slice(0, 10);
        const checkOut = String(booking.checkOut || '').slice(0, 10);

        // Nights, not days: departing today frees the room tonight, so today is
        // still inside the stay.
        return checkIn <= today && today < checkOut;
    }

    // =====================================================================
    // Basket
    // =====================================================================
    function addToBasket(item) {
        const existing = basket.get(item.id);
        if (existing) {
            existing.quantity += 1;
        } else {
            basket.set(item.id, { item, quantity: 1, instructions: '' });
        }
        renderBasket();
    }

    function changeQuantity(itemId, delta) {
        const line = basket.get(itemId);
        if (!line) return;

        line.quantity += delta;
        if (line.quantity <= 0) basket.delete(itemId);
        renderBasket();
    }

    function basketTotal() {
        let total = 0;
        for (const line of basket.values()) total += Number(line.item.price) * line.quantity;
        return total;
    }

    function renderBasket() {
        clear(basketBody);

        const count = [...basket.values()].reduce((sum, line) => sum + line.quantity, 0);
        countBadge.textContent = String(count);

        if (basket.size === 0) {
            showEmptyState(basketBody, {
                title: 'Your order is empty',
                message: 'Add a dish from the menu to get started.',
                icon: 'fa-basket-shopping',
            });
            return;
        }

        const list = createElement('ul', { class: 'space-y-3' });
        for (const line of basket.values()) {
            const row = createElement('li', { class: 'flex items-start justify-between gap-2' });

            const name = createElement('div', { class: 'min-w-0' });
            name.append(
                createElement('p', { class: 'text-sm font-medium text-stone-900', text: line.item.name }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: formatMoney(Number(line.item.price) * line.quantity),
                }),
            );
            name.appendChild(
                createElement('button', {
                    type: 'button',
                    class: 'text-xs text-stone-400 hover:text-stone-700 mt-1',
                    text: 'Add a note',
                    onclick: () => addInstruction(line),
                }),
            );

            if (line.instructions) {
                name.appendChild(
                    createElement('p', { class: 'text-xs text-amber-700 italic', text: line.instructions }),
                );
            }

            const stepper = createElement('div', { class: 'flex items-center gap-1 shrink-0' });
            stepper.append(
                createElement('button', {
                    type: 'button',
                    class: 'btn btn-ghost btn-sm',
                    'aria-label': `Remove one ${line.item.name}`,
                    text: '−',
                    onclick: () => changeQuantity(line.item.id, -1),
                }),
                createElement('span', { class: 'text-sm w-6 text-center', text: String(line.quantity) }),
                createElement('button', {
                    type: 'button',
                    class: 'btn btn-ghost btn-sm',
                    'aria-label': `Add one ${line.item.name}`,
                    text: '+',
                    onclick: () => changeQuantity(line.item.id, 1),
                }),
            );

            row.append(name, stepper);
            list.appendChild(row);
        }
        basketBody.appendChild(list);

        const total = createElement('div', {
            class: 'flex items-center justify-between mt-4 pt-3 border-t border-stone-200 font-semibold',
        });
        total.append(
            createElement('span', { text: 'Total' }),
            createElement('span', { text: formatMoney(basketTotal()) }),
        );
        basketBody.appendChild(total);

        basketBody.appendChild(
            createElement('p', {
                class: 'text-xs text-stone-500 mt-1',
                text: 'Tax and service charge are added at checkout.',
            }),
        );

        basketBody.appendChild(
            createElement('button', {
                type: 'button',
                class: 'btn btn-primary w-full mt-3',
                text: 'Place order',
                onclick: () => placeOrder(),
            }),
        );
    }

    /** A small dialog for a per-dish note, which the kitchen reads on the ticket. */
    function addInstruction(line) {
        openModal({
            title: `Note for ${line.item.name}`,
            bodyNode: (() => {
                const wrap = createElement('div');
                const label = createElement('label', { class: 'form-label', for: 'dish-note', text: 'Anything the kitchen should know?' });
                const input = createElement('input', {
                    class: 'form-input',
                    id: 'dish-note',
                    value: line.instructions || '',
                    placeholder: 'No onions, allergy, well done...',
                    maxlength: 200,
                });
                wrap.append(label, input);
                setTimeout(() => input.focus(), 0);
                return wrap;
            })(),
            footerNode: (() => {
                const footer = createElement('div', { class: 'flex justify-end gap-2' });
                const save = createElement('button', { type: 'button', class: 'btn btn-primary', text: 'Save note' });
                const cancel = createElement('button', {
                    type: 'button',
                    class: 'btn btn-outline',
                    text: 'Cancel',
                });
                footer.append(cancel, save);

                // openModal only wires up [data-modal-cancel] inside
                // confirmDialog, so this dialog's buttons need their own
                // listeners. Without them Cancel is a dead button.
                cancel.addEventListener('click', () => document.querySelector('dialog[open]')?.close());

                save.addEventListener('click', () => {
                    const input = document.getElementById('dish-note');
                    line.instructions = (input?.value || '').trim();
                    renderBasket();
                    document.querySelector('dialog[open]')?.close();
                });

                return footer;
            })(),
        });
    }

    async function placeOrder() {
        if (basket.size === 0) return;

        const canDeliver = Boolean(inHouseBooking?.roomId);
        const fulfilment = canDeliver ? 'room_delivery' : 'restaurant_pickup';

        const confirmed = await confirmDialog({
            title: 'Place this order?',
            message: canDeliver
                ? `It will be delivered to room ${inHouseBooking.roomNumber}. Total ${formatMoney(basketTotal())} before tax and service.`
                : `Collect it from the restaurant. Total ${formatMoney(basketTotal())} before tax and service.`,
            confirmLabel: 'Place order',
        });

        if (!confirmed) return;

        try {
            const result = await api.post('/orders', {
                fulfilmentType: fulfilment,
                // The server requires the room for a delivery and checks that
                // this guest is the one staying there, so it has to be sent
                // rather than inferred from the booking on the server.
                roomId: canDeliver ? inHouseBooking.roomId : undefined,
                items: [...basket.values()].map((line) => ({
                    menuItemId: line.item.id,
                    quantity: line.quantity,
                    specialInstructions: line.instructions || undefined,
                })),
            });

            const order = result?.data?.order || result?.data;
            basket.clear();
            renderBasket();
            notify.success(`Order ${order?.orderReference ?? ''} placed.`);

            if (order?.id) {
                window.location.href = `/pages/guest/order-details.html?id=${order.id}`;
            }
        } catch (error) {
            notify.error(error.message);
        }
    }

    await loadCategories();
    await loadStayContext();
    await Promise.all([loadItems(), renderBasket()]);
}
