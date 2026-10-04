/**
 * public/js/pages/guest/room-details.js
 *
 * WHAT THIS MODULE DOES
 * Everything about one room: the photographs, the layout, what is in it, what
 * it costs, and whether it is free for the dates the visitor is considering.
 *
 * WHY IT EXISTS
 * The search page answers "what is free", this page answers "is this the room I
 * want". It is reached from the Details link on a room card, which passes the
 * room id as `?id=`.
 *
 * WHY AVAILABILITY IS RE-CHECKED HERE
 * The card a guest clicked showed availability for the dates they searched.
 * By the time they have read the description those dates may be taken, so the
 * answer is queried again rather than trusted from the previous page. The
 * search is for the whole room TYPE, and this room is only free if it appears
 * in that result: a type can be bookable while every individual room of it is
 * occupied.
 *
 * COMMUNICATION
 * Page -> GET  /api/rooms/:id           (the room)
 *      -> GET  /api/rooms/availability  (is this room free for these dates)
 *      -> GET  /api/rooms/calendar      (nights already booked, shown as a strip)
 * Database tables used: rooms, room_types, amenities, room_amenities, bookings
 */
import { buildShell } from '../../components/shell.js';
import notify from '../../components/notification.js';
import roomsApi from '../../api/rooms.js';
import {
    createElement,
    clear,
    formatMoney,
    getQueryParam,
    todayInputValue,
    addDaysInputValue,
    nightsBetween,
    setButtonLoading,
    showEmptyState,
} from '../../lib/dom.js';

const roomId = getQueryParam('id');

const shell = await buildShell({
    title: 'Room details',
    subtitle: 'What this room offers',
});

if (shell?.content && roomId) {
    const { content } = shell;

    // =====================================================================
    // Availability search
    // =====================================================================
    // Built before the room is known so the form is not rebuilt on load.
    const searchCard = createElement('section', { class: 'card p-5 mb-6' });
    const searchForm = createElement('form', { class: 'grid gap-4 sm:grid-cols-4 items-end' });

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

    const guestsSelect = createElement('select', { id: 'guests', class: 'form-select' });
    for (let n = 1; n <= 6; n += 1) {
        guestsSelect.appendChild(
            createElement('option', {
                value: String(n),
                text: `${n} guest${n === 1 ? '' : 's'}`,
                selected: n === 2 ? 'selected' : null,
            }),
        );
    }

    searchForm.append(
        field('Check in', checkInInput),
        field('Check out', checkOutInput),
        field('Guests', guestsSelect),
        createElement('button', {
            type: 'submit',
            class: 'btn btn-primary',
            text: 'Check availability',
        }),
    );

    searchCard.appendChild(searchForm);
    content.appendChild(searchCard);

    function field(label, control) {
        const wrap = createElement('div', { class: 'field mb-0' });
        wrap.append(
            createElement('label', { class: 'form-label', text: label }),
            control,
        );
        return wrap;
    }

    // The result of the last search, rendered below the room.
    const verdict = createElement('div', { id: 'availability-result', class: 'mt-4' });

    // =====================================================================
    // Room
    // =====================================================================
    const detail = createElement('div', { id: 'room-detail' });
    content.append(detail, verdict);

    // Keep the two date inputs coherent, as on the search page.
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

    searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        checkAvailability();
    });

    // =====================================================================
    // Loading
    // =====================================================================

    async function loadRoom() {
        try {
            const result = await roomsApi.detail(roomId);
            const room = result?.data?.room;
            if (!room) throw new Error('That room could not be found.');

            document.title = `${room.roomType?.name || 'Room'} ${room.roomNumber} | Aurelia Grand Hotel`;

            // Held so the availability search can read the capacity and the
            // type id without fetching the room a second time.
            currentRoom = room;

            clear(detail);
            detail.appendChild(renderRoom(room));
        } catch (error) {
            clear(detail);
            showEmptyState(detail, {
                title: 'Room not found',
                message: error.message,
                icon: 'fa-magnifying-glass',
                actionHtml: '<a href="/pages/guest/rooms.html" class="btn btn-primary">Back to rooms</a>',
            });
        }
    }

    function renderRoom(room) {
        const wrapper = createElement('div', { class: 'grid gap-6 lg:grid-cols-3' });

        // ---- Gallery and facts ----
        const main = createElement('div', { class: 'lg:col-span-2 space-y-6' });

        const figure = createElement('figure', { class: 'rounded-xl overflow-hidden border border-stone-200 bg-stone-200' });
        // Rooms usually carry no photograph of their own, so fall back to the
        // room type image rather than showing the placeholder every time.
        const image = room.image || room.roomType?.image;

        if (image) {
            figure.appendChild(
                createElement('img', {
                    src: image,
                    // The number is already in the heading below, so repeating
                    // it for a screen reader adds noise rather than detail.
                    alt: `${room.roomType?.name || 'Room'} interior`,
                    class: 'w-full h-72 sm:h-96 object-cover',
                }),
            );
        } else {
            // A room type with no image and a room with no image. A placeholder
            // keeps the layout intact instead of leaving a broken image box.
            const placeholder = createElement('div', {
                class: 'h-72 sm:h-96 flex items-center justify-center text-stone-400',
            });
            placeholder.appendChild(
                createElement('i', { class: 'fa-solid fa-bed text-5xl', 'aria-hidden': 'true' }),
            );
            figure.appendChild(placeholder);
        }
        main.appendChild(figure);

        const heading = createElement('div', { class: 'card p-5' });
        heading.append(
            createElement('h2', {
                class: 'text-lg font-semibold text-stone-900',
                text: `${room.roomType?.name || 'Room'} ${room.roomNumber}`,
            }),
            createElement('p', {
                class: 'text-sm text-stone-500 mt-0.5',
                text: [
                    room.roomType?.bedConfiguration,
                    room.roomType?.sizeSqm ? `${room.roomType.sizeSqm} m²` : null,
                    room.floor != null ? `Floor ${room.floor}` : null,
                    `Sleeps ${room.capacity}`,
                ]
                    .filter(Boolean)
                    .join(' · '),
            }),
        );

        if (room.description) {
            heading.appendChild(
                createElement('p', { class: 'text-sm text-stone-700 mt-4 leading-relaxed', text: room.description }),
            );
        }
        main.appendChild(heading);

        // ---- Amenities ----
        const amenities = room.amenities || [];
        if (amenities.length > 0) {
            const list = createElement('div', { class: 'card p-5' });
            list.appendChild(
                createElement('h3', { class: 'text-sm font-semibold text-stone-900 uppercase tracking-wide mb-3', text: 'In this room' }),
            );

            const grid = createElement('ul', { class: 'grid gap-2 sm:grid-cols-2' });
            for (const amenity of amenities) {
                const item = createElement('li', { class: 'flex items-center gap-2 text-sm text-stone-700' });
                item.append(
                    createElement('i', {
                        class: `fa-solid ${amenity.icon || 'fa-check'} text-amber-600 w-4`,
                        'aria-hidden': 'true',
                    }),
                    createElement('span', { text: amenity.name }),
                );
                grid.appendChild(item);
            }
            list.appendChild(grid);
            main.appendChild(list);
        }

        // ---- Nights already taken ----
        const booked = createElement('div', { class: 'card p-5' });
        booked.appendChild(
            createElement('h3', { class: 'text-sm font-semibold text-stone-900 uppercase tracking-wide mb-3', text: 'Recently booked nights' }),
        );
        const bookedNights = createElement('p', { class: 'text-sm text-stone-500', text: 'Loading...' });
        booked.appendChild(bookedNights);
        main.appendChild(booked);

        void loadBookedNights(room.id, bookedNights);

        wrapper.appendChild(main);

        // ---- Price and call to action ----
        const aside = createElement('aside', { class: 'space-y-4' });

        const priceCard = createElement('div', { class: 'card p-5' });
        priceCard.append(
            createElement('p', { class: 'text-2xl font-bold text-stone-900', text: formatMoney(room.pricePerNight) }),
            createElement('p', { class: 'text-sm text-stone-500', text: 'per night, before tax and service' }),
        );
        aside.appendChild(priceCard);

        const actionCard = createElement('div', { class: 'card p-5' });
        actionCard.appendChild(
            createElement('p', {
                class: 'text-sm text-stone-600',
                text: 'Check the dates above, then continue to the booking form.',
            }),
        );

        const bookLink = createElement('a', {
            class: 'btn btn-primary btn-block mt-4',
            text: 'Book this room type',
            href: `/pages/guest/rooms.html?roomType=${room.roomType?.id ?? ''}`,
        });
        actionCard.appendChild(bookLink);

        const similarLink = createElement('a', {
            class: 'btn btn-outline btn-block mt-2',
            text: 'See all rooms',
            href: '/pages/guest/rooms.html',
        });
        actionCard.appendChild(similarLink);
        aside.appendChild(actionCard);

        wrapper.appendChild(aside);
        return wrapper;
    }

    /**
     * Shows the nights this room already has booked, so a guest can see why a
     * date might be unavailable instead of guessing.
     */
    async function loadBookedNights(roomIdValue, target) {
        try {
            // The calendar endpoint returns this month plus the next one.
            const result = await roomsApi.calendar(roomIdValue, { month: todayInputValue().slice(0, 7) });
            const dates = result?.data?.calendar?.occupiedNights || [];

            if (dates.length === 0) {
                target.textContent = 'Nothing booked this month or next.';
                return;
            }

            clear(target);
            const list = createElement('ul', { class: 'flex flex-wrap gap-1.5' });
            for (const date of dates.slice(0, 24)) {
                list.appendChild(
                    createElement('li', {
                        class: 'text-xs px-2 py-1 rounded bg-stone-100 text-stone-600',
                        text: date,
                    }),
                );
            }
            if (dates.length > 24) {
                list.appendChild(
                    createElement('li', {
                        class: 'text-xs px-2 py-1 text-stone-500',
                        text: `+${dates.length - 24} more`,
                    }),
                );
            }
            target.textContent = '';
            target.appendChild(list);
        } catch {
            // A missing calendar is informational, so its absence is not worth
            // an error message on top of the page's real purpose.
            target.textContent = 'Booked nights are not shown for this room.';
        }
    }

    /**
     * Re-queries availability for the chosen dates and reports whether this
     * specific room is among the free ones.
     */
    async function checkAvailability() {
        const checkIn = checkInInput.value;
        const checkOut = checkOutInput.value;
        const guests = Number(guestsSelect.value) || 1;

        if (!checkIn || !checkOut) {
            notify.warning('Choose both dates first.');
            return;
        }

        if (checkOut <= checkIn) {
            notify.warning('Check-out must be after check-in.');
            return;
        }

        if (guests > Number(currentRoom?.capacity || guests)) {
            notify.warning(`This room sleeps ${currentRoom?.capacity} guests.`);
            return;
        }

        clear(verdict);
        showBusy(verdict);

        const button = searchForm.querySelector('button[type="submit"]');
        setButtonLoading(button, true, 'Checking...');

        try {
            // Search the whole type, then look for this room inside the result.
            // Filtering in the browser would let a taken room look free.
            const result = await roomsApi.availability({
                checkIn,
                checkOut,
                guests,
                roomType: currentRoom?.roomType?.id,
                limit: 100,
            });

            const available = result?.data || [];
            const nights = nightsBetween(checkIn, checkOut);
            const thisRoomFree = available.some((room) => String(room.id) === String(roomId));

            clear(verdict);
            verdict.appendChild(renderVerdict({
                isFree: thisRoomFree,
                nights,
                checkIn,
                checkOut,
                total: currentRoom ? currentRoom.pricePerNight * nights : null,
            }));
        } catch (error) {
            clear(verdict);
            showEmptyState(verdict, {
                title: 'Could not check availability',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        } finally {
            setButtonLoading(button, false);
        }
    }

    function renderVerdict({ isFree, nights, checkIn, checkOut, total }) {
        const box = createElement('div', {
            class: `rounded-xl border p-5 ${
                isFree ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
            }`,
        });

        const heading = createElement('div', { class: 'flex items-center gap-2 mb-1' });
        heading.append(
            createElement('i', {
                class: `fa-solid ${isFree ? 'fa-circle-check text-emerald-600' : 'fa-circle-exclamation text-amber-600'}`,
                'aria-hidden': 'true',
            }),
            createElement('h3', {
                class: 'font-semibold text-stone-900',
                text: isFree
                    ? `Available for ${nights} night${nights === 1 ? '' : 's'}`
                    : `Fully booked for ${checkIn} to ${checkOut}`,
            }),
        );
        box.appendChild(heading);

        box.appendChild(
            createElement('p', {
                class: 'text-sm text-stone-600',
                text: isFree
                    ? `${checkIn} to ${checkOut}.`
                    : 'Try different dates, or look at the other rooms of this type.',
            }),
        );

        if (isFree && total != null) {
            box.appendChild(
                createElement('p', {
                    class: 'text-sm text-stone-700 mt-2',
                    text: `${formatMoney(total)} before tax and service.`,
                }),
            );

            // Carries the chosen dates into the search page, which reads them
            // from the URL, so the guest does not type them twice.
            const params = new URLSearchParams({
                checkIn,
                checkOut,
                guests: String(guestsSelect.value),
                roomType: String(currentRoom?.roomType?.id ?? ''),
            });
            box.appendChild(
                createElement('a', {
                    href: `/pages/guest/rooms.html?${params.toString()}`,
                    class: 'btn btn-primary mt-4',
                    text: 'Continue to booking',
                }),
            );
        } else if (!isFree) {
            box.appendChild(
                createElement('a', {
                    href: `/pages/guest/rooms.html?roomType=${currentRoom?.roomType?.id ?? ''}&checkIn=${checkIn}&checkOut=${checkOut}`,
                    class: 'btn btn-outline mt-4',
                    text: 'See similar rooms',
                }),
            );
        }

        return box;
    }

    function showBusy(target) {
        const line = createElement('p', { class: 'text-sm text-stone-500 flex items-center gap-2' });
        line.append(
            createElement('i', { class: 'fa-solid fa-spinner fa-spin', 'aria-hidden': 'true' }),
            createElement('span', { text: 'Checking availability...' }),
        );
        target.appendChild(line);
    }

    // Filled in by loadRoom, and read by the availability search below.
    let currentRoom = null;

    checkInInput.min = todayInputValue();
    checkInInput.value = addDaysInputValue(1);
    checkOutInput.value = addDaysInputValue(3);
    checkOutInput.min = addDaysInputValue(1, new Date(checkInInput.value));

    await loadRoom();
} else if (!roomId) {
    // Reached by hand or from a stale link. Say so rather than loading room 0.
    const shellWithoutRoom = await buildShell({ title: 'Room details' });
    if (shellWithoutRoom?.content) {
        showEmptyState(shellWithoutRoom.content, {
            title: 'No room selected',
            message: 'Choose a room from the list to see its details.',
            icon: 'fa-bed',
            actionHtml: '<a href="/pages/guest/rooms.html" class="btn btn-primary">Browse rooms</a>',
        });
    }
}