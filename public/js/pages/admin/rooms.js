/**
 * public/js/pages/admin/rooms.js
 *
 * WHAT THIS MODULE DOES
 * The room inventory: every room with its type, status and price, and the
 * controls to add, edit, re-status and remove one.
 *
 * WHY IT EXISTS
 * This is the master list behind the housekeeping board. Housekeeping moves a
 * room between states; this screen is where the inventory itself is defined, so
 * it carries the create and delete actions that the board deliberately does not.
 *
 * WHY DELETE IS RESTRICTED TO ADMIN
 * A room can only be deleted when nothing references it. A receptionist who
 * deletes a room with a booking against it would break a guest's stay, so the
 * delete button is only rendered for an administrator; the API enforces the same
 * rule independently.
 *
 * COMMUNICATION
 * Page -> GET    /api/rooms, /api/rooms/types, /api/rooms/status-counts
 *      -> POST   /api/rooms
 *      -> PATCH  /api/rooms/:id, /api/rooms/:id/status
 *      -> DELETE /api/rooms/:id
 * Database tables used: rooms, room_types, amenities
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    openFormModal,
    actionButtons,
    confirmAndRun,
} from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    statusBadge,
    formatMoney,
    formatNumber,
} from '../../lib/dom.js';

const ROLES = ['manager', 'admin'];

const STATUSES = [
    { value: '', label: 'All statuses' },
    { value: 'available', label: 'Available' },
    { value: 'occupied', label: 'Occupied' },
    { value: 'reserved', label: 'Reserved' },
    { value: 'cleaning', label: 'Cleaning' },
    { value: 'maintenance', label: 'Maintenance' },
];

/** Room statuses a staff member may set directly from this screen. */
const SETTABLE = ['available', 'occupied', 'reserved', 'cleaning', 'maintenance'];

const shell = await buildShell({
    title: 'Rooms',
    subtitle: 'Inventory and status',
    roles: ROLES,
});

if (shell?.content) {
    const { user, content } = shell;
    const canDelete = user.role === 'admin';

    let roomTypes = [];

    async function loadRoomTypes() {
        try {
            const result = await api.get('/rooms/types');
            roomTypes = result?.data?.roomTypes || result?.data || [];
        } catch {
            roomTypes = [];
        }
    }

    addHeaderAction({
        label: 'Add room',
        icon: 'fa-plus',
        onClick: () => createRoom(),
    });

    const state = { status: '', roomType: '', floor: '', search: '' };

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Room number or description...' },
                {
                    type: 'select',
                    name: 'status',
                    label: 'Status',
                    options: STATUSES,
                },
                {
                    type: 'select',
                    name: 'roomType',
                    label: 'Room type',
                    options: [{ value: '', label: 'All types' }],
                },
                { type: 'number', name: 'floor', label: 'Floor', min: 0, placeholder: 'Any' },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        { header: 'Room', render: (room) => createElement('span', { class: 'font-semibold', text: room.roomNumber }) },
        { header: 'Type', render: (room) => createElement('span', { text: room.roomType?.name || '-' }) },
        { header: 'Floor', render: (room) => createElement('span', { text: String(room.floor ?? '-') }) },
        {
            header: 'Sleeps',
            render: (room) => createElement('span', { text: String(room.capacity ?? '-') }),
        },
        {
            header: 'Rate',
            className: 'text-right',
            render: (room) => createElement('span', { text: formatMoney(room.pricePerNight) }),
        },
        { header: 'Status', render: (room) => statusBadge(room.status) },
        { header: 'Actions', className: 'text-right', render: (room) => actionsFor(room) },
    ];

    const controller = createListController({
        endpoint: '/rooms',
        container: listHost,
        state,
        limit: 15,
        empty: {
            title: 'No rooms match',
            message: 'Adjust the filters to see more of the inventory.',
            icon: 'fa-bed',
        },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    function actionsFor(room) {
        const acts = [
            {
                icon: 'fa-pen',
                label: 'Edit room',
                className: 'btn btn-ghost btn-sm',
                onClick: () => editRoom(room),
            },
            {
                icon: 'fa-arrows-rotate',
                label: 'Change status',
                className: 'btn btn-ghost btn-sm',
                onClick: () => changeStatus(room),
            },
        ];

        if (canDelete) {
            acts.push({
                icon: 'fa-trash',
                label: 'Delete room',
                className: 'btn btn-ghost btn-sm',
                onClick: () => removeRoom(room),
            });
        }

        return actionButtons(acts);
    }

    async function createRoom() {
        if (roomTypes.length === 0) {
            notify.error('No room types are configured. Add one before creating a room.');
            return;
        }

        const saved = await openFormModal({
            title: 'Add a room',
            submitLabel: 'Create room',
            fields: [
                { name: 'roomNumber', label: 'Room number', required: true, placeholder: 'e.g. 204' },
                {
                    name: 'roomTypeId',
                    label: 'Room type',
                    type: 'select',
                    required: true,
                    options: roomTypes.map((type) => ({ value: type.id, label: type.name })),
                },
                { name: 'floor', label: 'Floor', type: 'number', min: 0, value: 1 },
                { name: 'capacity', label: 'Capacity', type: 'number', min: 1, value: 2 },
                { name: 'pricePerNight', label: 'Rate per night', type: 'number', min: 0, step: '0.01', value: 100 },
                { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
            ],
            run: (values) => api.post('/rooms', values),
        });

        if (saved) {
            notify.success('Room created.');
            controller.load();
        }
    }

    async function editRoom(room) {
        const saved = await openFormModal({
            title: `Edit room ${room.roomNumber}`,
            submitLabel: 'Save changes',
            fields: [
                { name: 'roomNumber', label: 'Room number', required: true, value: room.roomNumber },
                {
                    name: 'roomTypeId',
                    label: 'Room type',
                    type: 'select',
                    required: true,
                    value: room.roomType?.id,
                    options: roomTypes.map((type) => ({ value: type.id, label: type.name })),
                },
                { name: 'floor', label: 'Floor', type: 'number', min: 0, value: room.floor },
                { name: 'capacity', label: 'Capacity', type: 'number', min: 1, value: room.capacity },
                {
                    name: 'pricePerNight',
                    label: 'Rate per night',
                    type: 'number',
                    min: 0,
                    step: '0.01',
                    value: room.pricePerNight,
                },
                { name: 'description', label: 'Description', type: 'textarea', rows: 3, value: room.description || '' },
            ],
            run: (values) => api.patch(`/rooms/${room.id}`, values),
        });

        if (saved) {
            notify.success('Room updated.');
            controller.load();
        }
    }

    async function changeStatus(room) {
        const saved = await openFormModal({
            title: `Change status of room ${room.roomNumber}`,
            submitLabel: 'Update status',
            fields: [
                {
                    name: 'status',
                    label: 'New status',
                    type: 'select',
                    required: true,
                    value: room.status,
                    options: SETTABLE.map((status) => ({
                        value: status,
                        label: status.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()),
                    })),
                },
            ],
            run: (values) => api.patch(`/rooms/${room.id}/status`, values),
        });

        if (saved) {
            notify.success('Room status updated.');
            controller.load();
        }
    }

    async function removeRoom(room) {
        const done = await confirmAndRun({
            title: `Delete room ${room.roomNumber}?`,
            message:
                'This permanently removes the room from the inventory. It can only be done if no booking or order refers to it.',
            confirmLabel: 'Delete room',
            run: () => api.delete(`/rooms/${room.id}`),
        });

        if (done) {
            notify.success('Room deleted.');
            controller.load();
        }
    }

    await loadRoomTypes();

    // The type filter can only be populated once the types are known.
    const typeSelect = content.querySelector('#filter-roomType');
    if (typeSelect) {
        for (const type of roomTypes) {
            typeSelect.appendChild(createElement('option', { value: type.id, text: type.name }));
        }
    }

    await controller.load();
}
