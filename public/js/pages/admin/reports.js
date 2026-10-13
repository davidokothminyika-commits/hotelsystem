/**
 * public/js/pages/admin/reports.js
 *
 * WHAT THIS MODULE DOES
 * Operational reporting: revenue and order mix, room occupancy, the most
 * popular dishes and the booking status breakdown, plus the finance report
 * (tax summary and daily revenue audit), all with a CSV export.
 *
 * WHY EVERY FIGURE COMES FROM AN AGGREGATE ENDPOINT
 * None of these numbers are computed from a paginated list. Totalling the
 * twenty rows the browser happens to have loaded and calling the result
 * "revenue" produces a confidently wrong answer, so each figure is read from
 * the endpoint that asked the database to aggregate it.
 *
 * WHY THE CSV EXPORT IS BUILT IN THE BROWSER
 * The data is already on the page, so there is nothing to fetch and no new
 * endpoint to secure. The file is produced from the same figures that are
 * displayed, which means the export can never disagree with the screen.
 *
 * COMMUNICATION
 * Page -> GET /api/orders/sales        (revenue, order mix)
 *      -> GET /api/orders/counts       (order status breakdown)
 *      -> GET /api/rooms/status-counts (occupancy)
 *      -> GET /api/bookings/counts     (booking status breakdown)
 *      -> GET /api/menu/popular        (best sellers)
 *      -> GET /api/reports/finance     (tax summary, daily revenue audit)
 * Database tables used: orders, order_items, rooms, bookings, menu_items,
 *                       invoices, payments
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { statCard } from '../../components/cards.js';
import api from '../../api/api.js';
import notify from '../../components/notification.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatMoney,
    formatNumber,
    formatRating,
    addDaysInputValue,
    todayInputValue,
} from '../../lib/dom.js';

const ROLES = ['manager', 'admin'];

const shell = await buildShell({
    title: 'Reports',
    subtitle: 'Revenue, occupancy and performance',
    roles: ROLES,
});

if (shell?.content) {
    const { content } = shell;

    /** Everything currently on screen, kept for the CSV export. */
    let report = {};

    /**
     * Finance report range: the last 30 days until the manager changes it.
     * Seeded with the same default the server applies, so the first render and
     * a later "Apply" always agree about which window they are showing.
     */
    let financeRange = { from: addDaysInputValue(-29), to: todayInputValue() };

    addHeaderAction({
        label: 'Export CSV',
        icon: 'fa-download',
        onClick: () => exportCsv(),
    });

    const statsRow = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6' });
    content.appendChild(statsRow);

    const grid = createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' });
    content.appendChild(grid);

    function panel(title, icon, body) {
        return createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, [
            createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex items-center gap-2' }, [
                createElement('i', { class: `fa-solid ${icon} text-amber-600`, 'aria-hidden': 'true' }),
                createElement('h2', { class: 'font-semibold text-stone-900', text: title }),
            ]),
            body,
        ]);
    }

    const revenueBody = createElement('div', { class: 'p-4' });
    const fulfilmentBody = createElement('div', { class: 'p-4' });
    const occupancyBody = createElement('div', { class: 'p-4' });
    const bookingsBody = createElement('div', { class: 'p-4' });
    const popularBody = createElement('div', { class: 'p-2' });

    grid.append(
        panel('Revenue', 'fa-sack-dollar', revenueBody),
        panel('Order mix', 'fa-chart-pie', fulfilmentBody),
        panel('Occupancy', 'fa-bed', occupancyBody),
        panel('Bookings by status', 'fa-calendar-check', bookingsBody),
    );
    grid.lastChild.append(panel('Best sellers', 'fa-utensils', popularBody));

    // ---- Finance: tax summary and daily revenue audit -------------------
    const financeStats = createElement('div', { class: 'grid grid-cols-2 lg:grid-cols-4 gap-4 p-4' });
    const taxBody = createElement('div', { class: 'p-4' });
    const paymentsBody = createElement('div', { class: 'p-4' });
    // One row per day, scrollable: a 366 day range must not push the rest of
    // the page off the screen.
    const dailyBody = createElement('div', { class: 'p-2 max-h-96 overflow-auto' });

    const fromInput = createElement('input', {
        type: 'date',
        id: 'financeFrom',
        class: 'form-input',
        value: financeRange.from,
    });
    const toInput = createElement('input', {
        type: 'date',
        id: 'financeTo',
        class: 'form-input',
        value: financeRange.to,
    });
    const applyButton = createElement('button', { type: 'button', class: 'btn btn-primary', text: 'Apply' });

    const financeSection = createElement('section', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm mb-6' }, [
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200 flex flex-wrap items-center gap-3' }, [
            createElement('i', { class: 'fa-solid fa-scale-balanced text-amber-600', 'aria-hidden': 'true' }),
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Finance' }),
            createElement('div', { class: 'ml-auto flex flex-wrap items-center gap-2' }, [
                createElement('label', { for: 'financeFrom', class: 'text-xs text-stone-500', text: 'From' }),
                fromInput,
                createElement('label', { for: 'financeTo', class: 'text-xs text-stone-500', text: 'To' }),
                toInput,
                applyButton,
            ]),
        ]),
        financeStats,
        createElement('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6 px-4 pb-4' }, [
            panel('Tax summary', 'fa-file-invoice-dollar', taxBody),
            panel('Collections', 'fa-credit-card', paymentsBody),
        ]),
        createElement('div', { class: 'px-4 pb-4' }, [
            panel('Daily revenue audit', 'fa-calendar-days', dailyBody),
        ]),
    ]);
    content.appendChild(financeSection);

    async function load() {
        showSkeleton(statsRow, 4, 'h-24');
        for (const body of [revenueBody, fulfilmentBody, occupancyBody, bookingsBody, popularBody]) {
            showSkeleton(body, 2, 'h-10');
        }
        showSkeleton(financeStats, 4, 'h-24');
        for (const body of [taxBody, paymentsBody, dailyBody]) {
            showSkeleton(body, 3, 'h-10');
        }

        const [sales, orderCounts, roomCounts, bookingCounts, popular, reviews, finance] = await Promise.all([
            api.get('/orders/sales').catch(() => null),
            api.get('/orders/counts').catch(() => null),
            api.get('/rooms/status-counts').catch(() => null),
            api.get('/bookings/counts').catch(() => null),
            api.get('/menu/popular').catch(() => null),
            api.get('/reviews/stats').catch(() => null),
            api.get(`/reports/finance?from=${financeRange.from}&to=${financeRange.to}`).catch(() => null),
        ]);

        report = {
            sales: sales?.data?.summary || null,
            orders: orderCounts?.data?.counts || {},
            rooms: roomCounts?.data?.counts || {},
            bookings: bookingCounts?.data?.counts || {},
            popular: popular?.data?.items || popular?.data || [],
            reviews: reviews?.data?.stats || null,
            finance: finance?.data?.report || null,
        };

        render();
    }

    function render() {
        const { sales, orders, rooms, bookings } = report;

        clear(statsRow);
        statsRow.append(
            statCard({
                label: 'Revenue',
                value: sales ? formatMoney(sales.revenue) : '-',
                hint: sales ? `${formatNumber(sales.totalOrders)} orders` : '',
                icon: 'fa-sack-dollar',
                tone: 'success',
            }),
            statCard({
                label: 'Average order',
                value: sales ? formatMoney(sales.averageOrder) : '-',
                hint: 'Across all fulfilment types',
                icon: 'fa-receipt',
                tone: 'info',
            }),
            statCard({
                label: 'Rooms occupied',
                value: formatNumber(rooms.occupied ?? 0),
                hint: `of ${formatNumber(rooms.total ?? 0)}`,
                icon: 'fa-bed',
                tone: 'warning',
            }),
            statCard({
                label: 'Average rating',
                // Filled in from the reviews endpoint when it is available.
                value: report.reviews ? formatRating(report.reviews.average) : '-',
                hint: report.reviews ? `${formatNumber(report.reviews.total)} visible reviews` : 'No reviews yet',
                icon: 'fa-star',
                tone: 'accent',
            }),
        );

        renderBreakdown(revenueBody, [
            ['Total orders', formatNumber(sales?.totalOrders ?? 0)],
            ['Total revenue', sales ? formatMoney(sales.revenue) : '-'],
            ['Average order', sales ? formatMoney(sales.averageOrder) : '-'],
        ]);

        renderBreakdown(fulfilmentBody, [
            ['Pending', formatNumber(orders.pending ?? 0)],
            ['Preparing', formatNumber(orders.preparing ?? 0)],
            ['Ready', formatNumber(orders.ready ?? 0)],
            ['Delivered', formatNumber(orders.delivered ?? 0)],
            ['Cancelled', formatNumber(orders.cancelled ?? 0)],
        ]);

        const totalRooms = Number(rooms.total || 0);
        const occupied = Number(rooms.occupied || 0);
        renderBreakdown(occupancyBody, [
            ['Total rooms', formatNumber(totalRooms)],
            ['Occupied', formatNumber(occupied)],
            ['Available', formatNumber(rooms.available ?? 0)],
            ['Cleaning', formatNumber(rooms.cleaning ?? 0)],
            ['Maintenance', formatNumber(rooms.maintenance ?? 0)],
            [
                'Occupancy rate',
                totalRooms ? `${Math.round((occupied / totalRooms) * 100)}%` : '-',
            ],
        ]);

        renderBreakdown(bookingsBody, [
            ['Pending', formatNumber(bookings.pending ?? 0)],
            ['Confirmed', formatNumber(bookings.confirmed ?? 0)],
            ['Checked in', formatNumber(bookings.checked_in ?? 0)],
            ['Checked out', formatNumber(bookings.checked_out ?? 0)],
            ['Cancelled', formatNumber(bookings.cancelled ?? 0)],
            ['Total', formatNumber(bookings.total ?? 0)],
        ]);

        renderPopular();
        renderFinance();
    }

    /** A two column label/value list. */
    function renderBreakdown(container, rows) {
        clear(container);
        for (const [label, value] of rows) {
            const row = createElement('div', { class: 'flex items-center justify-between py-1.5 border-b border-stone-100 last:border-0' });
            row.append(
                createElement('span', { class: 'text-sm text-stone-600', text: label }),
                createElement('span', { class: 'text-sm font-medium text-stone-900', text: value }),
            );
            container.appendChild(row);
        }
    }

    function renderPopular() {
        const items = Array.isArray(report.popular) ? report.popular : [];
        clear(popularBody);

        if (items.length === 0) {
            showEmptyState(popularBody, {
                title: 'No sales data',
                message: 'Best sellers appear once dishes have been ordered.',
                icon: 'fa-utensils',
            });
            return;
        }

        for (const item of items.slice(0, 10)) {
            const row = createElement('div', { class: 'flex items-center justify-between gap-3 px-2 py-2 border-b border-stone-100 last:border-0' });
            const left = createElement('div', { class: 'min-w-0' });
            left.append(
                createElement('p', { class: 'text-sm text-stone-900 truncate', text: item.name || 'Dish' }),
                createElement('p', {
                    class: 'text-xs text-stone-500',
                    text: item.categoryName || item.category || '',
                }),
            );
            row.append(
                left,
                createElement('span', {
                    class: 'text-sm font-medium text-stone-900',
                    text: `${formatNumber(item.totalQuantity ?? item.quantity ?? 0)} sold`,
                }),
            );
            popularBody.appendChild(row);
        }
    }

    /**
     * Re-fetches only the finance report for a new date range.
     *
     * The other panels are all-time figures, so changing the range must not
     * reload them or the page would flicker for no reason.
     */
    async function loadFinance() {
        showSkeleton(financeStats, 4, 'h-24');
        for (const body of [taxBody, paymentsBody, dailyBody]) {
            showSkeleton(body, 3, 'h-10');
        }

        try {
            const result = await api.get(`/reports/finance?from=${financeRange.from}&to=${financeRange.to}`);
            report.finance = result?.data?.report || null;
        } catch (error) {
            report.finance = null;
            // A rejected range is the one failure the manager can act on, so
            // it gets the message rather than the generic unavailable state.
            if (error?.isValidationError) {
                notify.error(error.message || 'That date range is not valid.');
            }
        }

        renderFinance();
    }

    /** Validates the inputs and reloads the finance figures for that range. */
    async function applyRange() {
        const from = fromInput.value;
        const to = toInput.value;

        if (!from || !to) {
            notify.warning('Choose both a start and an end date.');
            return;
        }
        if (from > to) {
            notify.warning('The start date must be on or before the end date.');
            return;
        }
        // Mirrors the server rule so a range that would be rejected does not
        // cost a round trip and a red error.
        const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
        if (spanDays > 366) {
            notify.warning('A report may cover at most 366 days.');
            return;
        }

        financeRange = { from, to };
        await loadFinance();
    }

    /** Renders the finance section from `report.finance`. */
    function renderFinance() {
        const finance = report.finance;

        clear(financeStats);
        if (!finance) {
            for (const body of [taxBody, paymentsBody, dailyBody]) {
                showEmptyState(body, {
                    title: 'Finance figures unavailable',
                    message: 'This account cannot load the finance report. It requires the report:read permission.',
                    icon: 'fa-lock',
                });
            }
            return;
        }

        const { tax, payments } = finance;

        financeStats.append(
            statCard({
                label: 'VAT collected',
                value: formatMoney(tax.tax),
                hint: `${Math.round(finance.pricing.taxRate * 100)}% of ${formatMoney(tax.subtotal)} net`,
                icon: 'fa-landmark',
                tone: 'info',
            }),
            statCard({
                label: 'Service charge',
                value: formatMoney(tax.serviceCharge),
                hint: `${Math.round(finance.pricing.serviceChargeRate * 100)}% of net sales`,
                icon: 'fa-hand-holding-dollar',
                tone: 'accent',
            }),
            statCard({
                label: 'Collected',
                value: formatMoney(payments.collected),
                hint: `${formatNumber(payments.collectedCount)} payments`,
                icon: 'fa-sack-dollar',
                tone: 'success',
            }),
            statCard({
                label: 'Refunded',
                value: formatMoney(payments.refunded),
                hint: `Net ${formatMoney(payments.net)}`,
                icon: 'fa-rotate-left',
                tone: 'warning',
            }),
        );

        renderBreakdown(taxBody, [
            ['Invoices issued', formatNumber(tax.invoicesIssued)],
            ['Net subtotal', formatMoney(tax.subtotal)],
            [`VAT (${Math.round(finance.pricing.taxRate * 100)}%)`, formatMoney(tax.tax)],
            [`Service charge (${Math.round(finance.pricing.serviceChargeRate * 100)}%)`, formatMoney(tax.serviceCharge)],
            ['Total invoiced', formatMoney(tax.totalInvoiced)],
            ['Room revenue (net)', formatMoney(tax.rooms.subtotal)],
            ['Food & beverage (net)', formatMoney(tax.food.subtotal)],
            ['Outstanding balance', `${formatMoney(tax.balanceDue)} (${formatNumber(tax.openInvoices)} open)`],
        ]);

        renderBreakdown(paymentsBody, [
            ['Range', `${finance.range.from} to ${finance.range.to}`],
            ['Collected', formatMoney(payments.collected)],
            ['Card', formatMoney(payments.byMethod.card)],
            ['Mobile money', formatMoney(payments.byMethod.mobile_money)],
            ['Cash', formatMoney(payments.byMethod.cash)],
            ['Refunded', formatMoney(payments.refunded)],
            ['Net takings', formatMoney(payments.net)],
        ]);

        renderDaily(finance);
    }

    /**
     * One row per day in the range, with a totals foot.
     *
     * The totals are summed here from the same rows on screen, which keeps the
     * footer from ever disagreeing with the days above it; they equal the
     * server's summary figures by construction (both come from the same range).
     */
    function renderDaily(finance) {
        clear(dailyBody);

        const columns = [
            ['Date', 'text-left'],
            ['Billed', 'text-right'],
            ['Tax', 'text-right'],
            ['Collected', 'text-right'],
            ['Refunded', 'text-right'],
            ['Net', 'text-right'],
        ];
        const cell = (text, align) => createElement('td', { class: `px-2 py-1.5 ${align}`, text });
        const round2 = (value) => Number(value.toFixed(2));

        const table = createElement('table', { class: 'w-full text-sm' }, [
            createElement('thead', {}, [
                createElement('tr', { class: 'text-xs uppercase text-stone-500' },
                    columns.map(([label, align]) =>
                        createElement('th', { class: `px-2 py-2 font-semibold ${align}`, text: label })),
                ),
            ]),
        ]);

        const tbody = createElement('tbody');
        const totals = { invoiced: 0, tax: 0, collected: 0, refunded: 0, net: 0 };

        for (const day of finance.daily) {
            totals.invoiced += day.invoiced;
            totals.tax += day.tax;
            totals.collected += day.collected;
            totals.refunded += day.refunded;
            totals.net += day.net;

            tbody.appendChild(createElement('tr', { class: 'border-t border-stone-100' }, [
                cell(day.date, 'text-left'),
                cell(formatMoney(day.invoiced), 'text-right'),
                cell(formatMoney(day.tax), 'text-right'),
                cell(formatMoney(day.collected), 'text-right'),
                cell(formatMoney(day.refunded), 'text-right'),
                cell(formatMoney(day.net), 'text-right font-medium'),
            ]));
        }

        table.appendChild(tbody);
        table.appendChild(createElement('tfoot', {}, [
            createElement('tr', { class: 'border-t-2 border-stone-200 font-semibold text-stone-900' }, [
                cell('Total', 'text-left'),
                cell(formatMoney(round2(totals.invoiced)), 'text-right'),
                cell(formatMoney(round2(totals.tax)), 'text-right'),
                cell(formatMoney(round2(totals.collected)), 'text-right'),
                cell(formatMoney(round2(totals.refunded)), 'text-right'),
                cell(formatMoney(round2(totals.net)), 'text-right'),
            ]),
        ]));

        dailyBody.appendChild(table);
    }

    applyButton.addEventListener('click', () => applyRange());

    /**
     * Exports the figures already on screen.
     *
     * Built from `report` rather than refetched, so the file always matches what
     * the manager was looking at.
     */
    function exportCsv() {
        const lines = [['Metric', 'Value']];

        const push = (section, rows) => {
            lines.push([]);
            lines.push([section, '']);
            for (const [label, value] of rows) lines.push([label, value]);
        };

        const { sales, orders, rooms, bookings } = report;
        const totalRooms = Number(rooms.total || 0);
        const occupied = Number(rooms.occupied || 0);

        lines.push(['Aurelia Grand Hotel report', new Date().toISOString().slice(0, 10)]);
        push('Revenue', [
            ['Total orders', sales?.totalOrders ?? 0],
            ['Total revenue', sales?.revenue ?? 0],
            ['Average order', sales?.averageOrder ?? 0],
        ]);
        push('Occupancy', [
            ['Total rooms', totalRooms],
            ['Occupied', occupied],
            ['Available', rooms.available ?? 0],
            ['Occupancy rate %', totalRooms ? Math.round((occupied / totalRooms) * 100) : 0],
        ]);
        push('Orders', [
            ['Pending', orders.pending ?? 0],
            ['Preparing', orders.preparing ?? 0],
            ['Ready', orders.ready ?? 0],
            ['Delivered', orders.delivered ?? 0],
            ['Cancelled', orders.cancelled ?? 0],
        ]);
        push('Bookings', [
            ['Pending', bookings.pending ?? 0],
            ['Confirmed', bookings.confirmed ?? 0],
            ['Checked in', bookings.checked_in ?? 0],
            ['Checked out', bookings.checked_out ?? 0],
            ['Cancelled', bookings.cancelled ?? 0],
        ]);

        const finance = report.finance;
        if (finance) {
            push('Finance - tax summary', [
                ['Invoices issued', finance.tax.invoicesIssued],
                ['Net subtotal', finance.tax.subtotal],
                ['VAT', finance.tax.tax],
                ['Service charge', finance.tax.serviceCharge],
                ['Total invoiced', finance.tax.totalInvoiced],
                ['Room revenue (net)', finance.tax.rooms.subtotal],
                ['Food and beverage (net)', finance.tax.food.subtotal],
                ['Outstanding balance', finance.tax.balanceDue],
            ]);
            push('Finance - collections', [
                ['Collected', finance.payments.collected],
                ['Card', finance.payments.byMethod.card],
                ['Mobile money', finance.payments.byMethod.mobile_money],
                ['Cash', finance.payments.byMethod.cash],
                ['Refunded', finance.payments.refunded],
                ['Net', finance.payments.net],
            ]);
            // The daily audit is a table rather than label/value pairs, so it
            // keeps its own header row.
            lines.push([]);
            lines.push(['Day', 'Billed', 'Tax', 'Collected', 'Refunded', 'Net']);
            for (const day of finance.daily) {
                lines.push([day.date, day.invoiced, day.tax, day.collected, day.refunded, day.net]);
            }
        }

        // Every cell is quoted so a comma inside a value cannot shift a column.
        const csv = lines
            .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const link = createElement('a', { href: url, download: `hotel-report-${new Date().toISOString().slice(0, 10)}.csv` });
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    await load();
}
