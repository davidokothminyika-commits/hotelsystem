/**
 * public/js/pages/rooms.js
 *
 * WHAT THIS MODULE DOES
 * The room search page: date and party filters, result cards, and the
 * booking flow.
 *
 * WHY IT EXISTS
 * Availability is resolved by the database, not by filtering a list in the
 * browser, so what a guest sees is what they can actually book. Filters that
 * feel instant are debounced and every change re-queries the API.
 *
 * COMMUNICATION
 * Page -> this module -> /api/rooms/availability (availability and filtering)
 *                   -> /api/rooms/types, /api/rooms/amenities (filter options)
 *                   -> /api/bookings (creating the reservation)
 */
import { buildShell } from '../components/shell.js';
import { roomCard, pagination } from '../components/cards.js';
import { openModal } from '../components/modal.js';
import notify from '../components/notification.js';
import roomsApi from '../api/rooms.js';
import api from '../api/api.js';
import authApi from '../api/auth.js';
import {
    createElement,
    formatMoney,
    nightsBetween,
    debounce,
    showSkeleton,
    showEmptyState,
    getQueryParam,
    todayInputValue,
    addDaysInputValue,
    setButtonLoading,
} from '../lib/dom.js';

const shell = await buildShell({
    title: 'Rooms',
    subtitle: 'Find a room for your stay',
});

if (shell?.content) {
    const { content } = shell;

    // =====================================================================
    // Filter panel
    // =====================================================================
    const filterCard = createElement('section', { class: 'card p-5 mb-6' });
    const filterForm = createElement('form', { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-6 items-end' });

    // ---- Dates ----
    const checkInInput = createElement('input', {
        type: 'date',
        id: 'checkIn',
        name: 'checkIn',
        class: 'form-input',
        required: 'required',
    });
    const checkOutInput = createElement('input', {
        type: 'date',
        id: 'checkOut',
        name: 'checkOut',
        class: 'form-input',
        required: 'required',
    });

    const dateWrap = createElement('div', { class: 'lg:col-span-2' });
    dateWrap.append(
        createElement('label', { for: 'checkIn', class: 'form-label', text: 'Dates' }),
        createElement('div', { class: 'grid grid-cols-2 gap-2' }, [checkInInput, checkOutInput]),
    );

    // ---- Guests ----
    const guestsSelect = createElement('select', { id: 'guests', name: 'guests', class: 'form-select' });
    for (let n = 1; n <= 6; n += 1) {
        guestsSelect.appendChild(
            createElement('option', { value: String(n), text: `${n} guest${n === 1 ? '' : 's'}` }),
        );
    }

    const guestsWrap = createElement('div');
    guestsWrap.append(
        createElement('label', { for: 'guests', class: 'form-label', text: 'Guests' }),
        guestsSelect,
    );

    // ---- Room type ----
    const typeSelect = createElement('select', { id: 'roomType', name: 'roomType', class: 'form-select' });
    typeSelect.appendChild(createElement('option', { value: '', text: 'Any type' }));

    const typeWrap = createElement('div');
    typeWrap.append(
        createElement('label', { for: 'roomType', class: 'form-label', text: 'Room type' }),
        typeSelect,
    );

    // ---- Price band ----
    const priceSelect = createElement('select', { id: 'price', name: 'price', class: 'form-select' });
    const PRICE_BANDS = [
        { value: '', label: 'Any price' },
        { value: '0-100', label: 'Under USD 100' },
        { value: '100-200', label: 'USD 100 to 200' },
        { value: '200-300', label: 'USD 200 to 300' },
        { value: '300-', label: 'USD 300 and above' },
    ];
    for (const band of PRICE_BANDS) {
        priceSelect.appendChild(createElement('option', { value: band.value, text: band.label }));
    }

    const priceWrap = createElement('div');
    priceWrap.append(
        createElement('label', { for: 'price', class: 'form-label', text: 'Price' }),
        priceSelect,
    );

    // ---- Submit ----
    const submitWrap = createElement('div', { class: 'lg:col-span-2 flex gap-2' });
    const searchButton = createElement('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Search' });
    searchButton.prepend(createElement('i', { class: 'fa-solid fa-magnifying-glass mr-2', 'aria-hidden': 'true' }));

    const resetButton = createElement('button', {
        type: 'button',
        class: 'btn btn-outline',
        text: 'Reset',
        'aria-label': 'Reset filters',
    });

    submitWrap.append(searchButton, resetButton);
    filterForm.append(dateWrap, guestsWrap, typeWrap, priceWrap, submitWrap);
    filterCard.appendChild(filterForm);
    content.appendChild(filterCard);

    // =====================================================================
    // Results
    // =====================================================================
    const resultHeader = createElement('div', {
        class: 'flex flex-wrap items-center justify-between gap-3 mb-4',
    });
    const resultSummary = createElement('p', { class: 'text-sm text-stone-600' });
    resultHeader.appendChild(resultSummary);

    const sortSelect = createElement('select', {
        id: 'sortBy',
        class: 'form-select w-auto text-sm',
        'aria-label': 'Sort results',
    });
    const SORT_OPTIONS = [
        { value: 'r.price_per_night:asc', label: 'Price: low to high' },
        { value: 'r.price_per_night:desc', label: 'Price: high to low' },
        { value: 'r.capacity:desc', label: 'Largest capacity' },
        { value: 'r.room_number:asc', label: 'Room number' },
        { value: 'rt.name:asc', label: 'Room type' },
    ];
    for (const option of SORT_OPTIONS) {
        sortSelect.appendChild(createElement('option', { value: option.value, text: option.label }));
    }
    resultHeader.appendChild(sortSelect);

    const results = createElement('div', { id: 'room-results', class: 'grid gap-5 sm:grid-cols-2 xl:grid-cols-3' });
    const paginationSlot = createElement('div', { id: 'room-pagination', class: 'mt-6' });

    content.append(resultHeader, results, paginationSlot);

    // =====================================================================
    // State
    // =====================================================================
    const state = {
        page: 1,
        limit: 9,
        totalPages: 1,
        total: 0,
        rooms: [],
        search: null,
    };

    /** Reads the current filter values into a plain object. */
    function currentQuery() {
        const [sortBy, sortDir] = sortSelect.value.split(':');
        const [minPrice = '', maxPrice = ''] = priceSelect.value.split('-');

        return {
            checkIn: checkInInput.value,
            checkOut: checkOutInput.value,
            guests: guestsSelect.value,
            roomType: typeSelect.value || undefined,
            minPrice: minPrice || undefined,
            maxPrice: maxPrice || undefined,
            sortBy,
            sortDir,
        };
    }

    // =====================================================================
    // Loading
    // =====================================================================
    async function load() {
        const query = currentQuery();

        // Validates the date range before spending a request on it.
        const nights = nightsBetween(query.checkIn, query.checkOut);
        if (nights < 1) {
            showEmptyState(results, {
                title: 'Check your dates',
                message: 'Check-out must be at least one night after check-in.',
                icon: 'fa-calendar-xmark',
            });
            resultSummary.textContent = '';
            return;
        }

        showSkeleton(results, 6, 'h-96');
        paginationSlot.textContent = '';

        try {
            const result = await roomsApi.availability({
                ...query,
                page: state.page,
                limit: state.limit,
            });

            state.rooms = result?.data || [];
            state.total = result?.meta?.total || 0;
            state.totalPages = result?.meta?.totalPages || 1;
            state.search = nightsBetween(query.checkIn, query.checkOut);

            renderSummary();
            renderResults();
            renderPagination();
        } catch (error) {
            showEmptyState(results, {
                title: 'Search failed',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
            resultSummary.textContent = '';
        }
    }

    function renderSummary() {
        const nights = state.search;
        resultSummary.textContent =
            state.total === 0
                ? 'No rooms available for those dates'
                : `${state.total} room${state.total === 1 ? '' : 's'} available for ${nights} night${nights === 1 ? '' : 's'}, ${guestsSelect.value} guest${guestsSelect.value === '1' ? '' : 's'}`;
    }

    function renderResults() {
        if (state.rooms.length === 0) {
            showEmptyState(results, {
                title: 'No rooms match your search',
                message: 'Try different dates, a smaller party, or a different room type.',
                icon: 'fa-bed',
                actionHtml: '<button type="button" class="btn btn-outline" data-reset>Clear filters</button>',
            });
            results.querySelector('[data-reset]')?.addEventListener('click', resetFilters);
            return;
        }

        results.textContent = '';

        for (const room of state.rooms) {
            // The stay length travels with each card so it can label the total.
            const card = roomCard({ ...room, nights: state.search }, openBooking);
            results.appendChild(card);
        }
    }

    function renderPagination() {
        paginationSlot.textContent = '';
        paginationSlot.appendChild(
            pagination({
                page: state.page,
                totalPages: state.totalPages,
                total: state.total,
                onChange: (page) => {
                    state.page = page;
                    load();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                },
            }),
        );
    }

    // =====================================================================
    // Booking
    // =====================================================================
    async function openBooking(room) {
        // Booking requires an account. Check before opening the dialog so the
        // guest is not asked to fill a form they cannot submit.
        const user = await authApi.me();
        if (!user) {
            notify.info('Please sign in to complete your booking.');
            const returnTo = encodeURIComponent(`/pages/guest/rooms.html?${new URLSearchParams(currentQuery())}`);
            window.location.href = `/pages/auth/login.html?returnTo=${returnTo}`;
            return;
        }

        const { checkIn, checkOut } = currentQuery();
        const nights = nightsBetween(checkIn, checkOut);

        const subtotal = room.pricePerNight * nights;
        const tax = subtotal * 0.16;
        const service = subtotal * 0.10;
        const total = subtotal + tax + service;

        const body = createElement('div');

        // ---- Summary ----
        const summary = createElement('div', { class: 'card bg-stone-50 border-stone-200 mb-5' });
        const summaryBody = createElement('div', { class: 'card-body p-4' });

        summaryBody.appendChild(
            createElement('p', { class: 'font-semibold text-stone-900', text: `${room.roomType?.name || 'Room'} ${room.roomNumber}` }),
        );
        summaryBody.appendChild(
            createElement('p', {
                class: 'text-sm text-stone-500 mt-0.5',
                text: `${nights} night${nights === 1 ? '' : 's'}, ${checkIn} to ${checkOut}`,
            }),
        );
        summary.appendChild(summaryBody);
        body.appendChild(summary);

        // ---- Guest count ----
        const guestsField = createElement('div', { class: 'field' });
        guestsField.appendChild(createElement('label', { class: 'form-label', text: 'Number of guests' }));

        const bookingGuests = createElement('select', { name: 'guests', class: 'form-select' });
        for (let n = 1; n <= Math.min(room.capacity, 6); n += 1) {
            bookingGuests.appendChild(
                createElement('option', {
                    value: String(n),
                    text: `${n} guest${n === 1 ? '' : 's'}`,
                    selected: String(n) === guestsSelect.value ? 'selected' : null,
                }),
            );
        }
        guestsField.appendChild(bookingGuests);
        body.appendChild(guestsField);

        // ---- Special requests ----
        const requestField = createElement('div', { class: 'field' });
        requestField.appendChild(createElement('label', { class: 'form-label', text: 'Special requests (optional)' }));

        const requests = createElement('textarea', {
            name: 'specialRequests',
            rows: '3',
            class: 'form-textarea',
            placeholder: 'Late arrival, a quiet room, a cot for a child...',
        });
        requestField.appendChild(requests);
        requestField.appendChild(
            createElement('p', {
                class: 'form-hint',
                text: 'We will do our best to accommodate, but requests cannot be guaranteed.',
            }),
        );
        body.appendChild(requestField);

        // ---- Price breakdown ----
        const breakdown = createElement('div', { class: 'border-t border-stone-200 pt-4 mt-4' });

        const LINES = [
            { label: `${formatMoney(room.pricePerNight)} x ${nights} night${nights === 1 ? '' : 's'}`, value: subtotal },
            { label: 'Tax (16%)', value: tax },
            { label: 'Service charge (10%)', value: service },
        ];

        for (const line of LINES) {
            const row = createElement('div', { class: 'flex justify-between text-sm text-stone-600 py-1' });
            row.append(
                createElement('span', { text: line.label }),
                createElement('span', { text: formatMoney(line.value) }),
            );
            breakdown.appendChild(row);
        }

        const totalRow = createElement('div', {
            class: 'flex justify-between font-bold text-stone-900 pt-3 mt-2 border-t border-stone-200',
        });
        totalRow.append(
            createElement('span', { text: 'Total' }),
            createElement('span', { text: formatMoney(total) }),
        );
        breakdown.appendChild(totalRow);
        body.appendChild(breakdown);

        const submit = createElement('button', {
            type: 'button',
            class: 'btn btn-primary btn-lg',
            text: 'Confirm booking',
        });

        const cancel = createElement('button', {
            type: 'button',
            class: 'btn btn-outline',
            text: 'Cancel',
        });

        const footer = createElement('div', { class: 'flex flex-col-reverse sm:flex-row sm:justify-end gap-2' });
        footer.append(cancel, submit);

        submit.addEventListener('click', async () => {
            setButtonLoading(submit, true, 'Confirming...');

            try {
                const result = await api.post('/bookings', {
                    roomId: room.id,
                    checkIn,
                    checkOut,
                    guests: Number(bookingGuests.value),
                    adults: Number(bookingGuests.value),
                    children: 0,
                    specialRequests: requests.value.trim() || undefined,
                });

                const booking = result.data.booking;
                notify.success(`Booking ${booking.bookingReference} created.`);
                window.location.href = `/pages/guest/booking-details.html?id=${booking.id}&created=1`;
            } catch (error) {
                setButtonLoading(submit, false);

                if (error.code === 'ROOM_UNAVAILABLE') {
                    // The most likely conflict: another guest took the room
                    // between the search and this submission. Close the
                    // dialog and refresh so the results reflect reality.
                    notify.error('That room was just booked for those dates. Refreshing the results.');
                    dialog.close();
                    setTimeout(load, 600);
                    return;
                }

                notify.error(error.message);
            }
        });

        const dialog = openModal({
            title: 'Confirm your booking',
            description: `${room.roomType?.name || 'Room'} ${room.roomNumber}`,
            bodyNode: body,
            size: 'lg',
            opener: document.activeElement,
            footerNode: footer,
        });

        cancel.addEventListener('click', () => dialog.close());
    }

    // =====================================================================
    // Filters
    // =====================================================================
    function resetFilters() {
        checkInInput.value = addDaysInputValue(1);
        checkOutInput.value = addDaysInputValue(3);
        guestsSelect.value = '2';
        typeSelect.value = '';
        priceSelect.value = '';
        sortSelect.value = SORT_OPTIONS[0].value;
        state.page = 1;
        load();
    }

    filterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        state.page = 1;
        load();
    });

    resetButton.addEventListener('click', resetFilters);

    // Sorting re-queries rather than reordering the current page, because the
    // results are paginated: sorting client side would only reorder one page.
    sortSelect.addEventListener('change', () => {
        state.page = 1;
        load();
    });

    // Guest count only affects filtering, so it loads immediately on change.
    guestsSelect.addEventListener('change', () => {
        state.page = 1;
        load();
    });

    // The date inputs stay coherent with one another.
    checkInInput.addEventListener('change', () => {
        checkInInput.min = todayInputValue();
        if (checkOutInput.value <= checkInInput.value) {
            checkOutInput.value = addDaysInputValue(1, new Date(checkInInput.value));
        }
        checkOutInput.min = addDaysInputValue(1, new Date(checkInInput.value));
    });

    checkOutInput.addEventListener('change', () => {
        if (checkOutInput.value <= checkInInput.value) {
            notify.warning('Check-out must be after check-in.');
            checkOutInput.value = addDaysInputValue(1, new Date(checkInInput.value));
        }
    });

    // =====================================================================
    // Initialise
    // =====================================================================
    // Deep links from the home page carry the search in the URL, so the page
    // can be shared or bookmarked with its filters applied.
    const params = new URLSearchParams(window.location.search);

    checkInInput.min = todayInputValue();
    checkInInput.value = params.get('checkIn') || addDaysInputValue(1);
    checkOutInput.value = params.get('checkOut') || addDaysInputValue(3);
    checkOutInput.min = addDaysInputValue(1, new Date(checkInInput.value));

    if (params.get('guests')) guestsSelect.value = params.get('guests');
    if (params.get('minPrice') || params.get('maxPrice')) {
        const min = params.get('minPrice') || '0';
        const max = params.get('maxPrice') || '';
        priceSelect.value = `${min}-${max}`;
    }

    // Load room types for the filter dropdown.
    try {
        const result = await roomsApi.roomTypes();
        for (const type of result?.data?.roomTypes || []) {
            typeSelect.appendChild(createElement('option', { value: String(type.id), text: type.name }));
        }
        if (params.get('roomType')) {
            // The home page passes a slug, while the API filter takes an id.
            const match = (result?.data?.roomTypes || []).find((t) => t.slug === params.get('roomType'));
            if (match) typeSelect.value = String(match.id);
        }
    } catch (error) {
        notify.warning('Room type filters are unavailable.');
    }

    await load();
}