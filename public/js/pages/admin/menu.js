/**
 * public/js/pages/admin/menu.js
 *
 * WHAT THIS MODULE DOES
 * The menu: every item grouped by category, with create, edit, sold-out toggling
 * and delete.
 *
 * WHY ITEMS ARE GROUPED BY CATEGORY
 * The kitchen and the guest both think in categories, not one flat list, so the
 * screen is arranged the same way. The category filter narrows it further.
 *
 * WHY SOLD OUT IS A SEPARATE ACTION
 * Running out of something is a daily event and must be one click for the person
 * standing at the pass. It is kept distinct from editing the item, because
 * editing a price should not require three form fields to be correct first.
 *
 * COMMUNICATION
 * Page -> GET  /api/menu/categories, /api/menu?limit=...
 *      -> POST /api/menu
 *      -> PATCH /api/menu/:id, /api/menu/:id/availability
 *      -> DELETE /api/menu/:id
 * Database tables used: menu_items, menu_categories
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
import { createElement, formatMoney } from '../../lib/dom.js';

const ROLES = ['restaurant_staff', 'manager', 'admin'];

const shell = await buildShell({
    title: 'Menu',
    subtitle: 'Dishes, prices and availability',
    roles: ROLES,
});

if (shell?.content) {
    const { user, content } = shell;
    const canDelete = user.role === 'manager' || user.role === 'admin';

    let categories = [];

    async function loadCategories() {
        try {
            const result = await api.get('/menu/categories');
            categories = result?.data?.categories || [];
        } catch {
            categories = [];
        }
    }

    addHeaderAction({
        label: 'Add dish',
        icon: 'fa-plus',
        onClick: () => createItem(),
    });

    content.appendChild(
        createToolbar(
            [
                { type: 'search', name: 'search', label: 'Search', placeholder: 'Dish name...' },
                {
                    type: 'select',
                    name: 'category',
                    label: 'Category',
                    options: [{ value: '', label: 'All categories' }],
                },
            ],
            (name, value) => controller.setFilter(name, value),
        ),
    );

    const listHost = createElement('div');
    content.appendChild(listHost);

    const columns = [
        { header: 'Dish', render: (item) => createElement('span', { class: 'font-medium', text: item.name }) },
        {
            header: 'Description',
            render: (item) =>
                createElement('span', {
                    class: 'text-xs text-stone-500 max-w-md whitespace-pre-wrap',
                    text: item.description || '-',
                }),
        },
        {
            header: 'Price',
            className: 'text-right',
            render: (item) => createElement('span', { class: 'text-sm', text: formatMoney(item.price) }),
        },
        {
            header: 'Prep',
            render: (item) =>
                createElement('span', { class: 'text-sm text-stone-600', text: item.prepMinutes ? `${item.prepMinutes}m` : '-' }),
        },
        {
            header: 'Tags',
            render: (item) => {
                const wrap = createElement('div', { class: 'flex flex-wrap gap-1' });
                // The API names this field isVeg, not isVegetarian.
                if (item.isVeg) wrap.appendChild(createElement('span', { class: 'badge badge-success', text: 'Veg' }));
                if (item.isSpicy) wrap.appendChild(createElement('span', { class: 'badge badge-danger', text: 'Spicy' }));
                if (item.isFeatured) wrap.appendChild(createElement('span', { class: 'badge badge-accent', text: 'Featured' }));
                return wrap;
            },
        },
        {
            header: 'Available',
            render: (item) =>
                item.isAvailable
                    ? createElement('span', { class: 'badge badge-success', text: 'On the menu' })
                    : createElement('span', { class: 'badge badge-neutral', text: 'Sold out' }),
        },
        { header: 'Actions', className: 'text-right', render: (item) => actionsFor(item) },
    ];

    const controller = createListController({
        endpoint: '/menu',
        container: listHost,
        state: { search: '', category: '' },
        limit: 25,
        empty: { title: 'No dishes match', message: 'Try a different search or category.', icon: 'fa-utensils' },
        render(rows, { slot }) {
            const table = createTable({ columns });
            renderRows({ body: table.body, rows, columns });
            slot.appendChild(table.wrapper);
        },
    });

    function actionsFor(item) {
        const acts = [
            {
                icon: item.isAvailable ? 'fa-ban' : 'fa-check',
                label: item.isAvailable ? 'Mark sold out' : 'Put back on the menu',
                className: 'btn btn-ghost btn-sm',
                onClick: () => toggleAvailability(item),
            },
            {
                icon: 'fa-pen',
                label: 'Edit dish',
                className: 'btn btn-ghost btn-sm',
                onClick: () => editItem(item),
            },
        ];

        if (canDelete) {
            acts.push({
                icon: 'fa-trash',
                label: 'Delete dish',
                className: 'btn btn-ghost btn-sm',
                onClick: () => removeItem(item),
            });
        }

        return actionButtons(acts);
    }

    function categoryOptions() {
        return categories.map((category) => ({ value: category.id, label: category.name }));
    }

    async function createItem() {
        if (categories.length === 0) {
            notify.error('No menu categories are configured yet.');
            return;
        }

        const saved = await openFormModal({
            title: 'Add a dish',
            submitLabel: 'Create dish',
            fields: [
                { name: 'name', label: 'Name', required: true },
                { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
                { name: 'categoryId', label: 'Category', type: 'select', required: true, options: categoryOptions() },
                { name: 'price', label: 'Price', type: 'number', min: 0.01, step: '0.01', required: true },
                { name: 'prepMinutes', label: 'Preparation minutes', type: 'number', min: 1, value: 15 },
                { name: 'isVegetarian', label: 'Vegetarian', type: 'checkbox', value: false },
                { name: 'isSpicy', label: 'Spicy', type: 'checkbox', value: false },
                { name: 'isFeatured', label: 'Featured', type: 'checkbox', value: false },
                { name: 'isAvailable', label: 'Available', type: 'checkbox', value: true },
            ],
            run: (values) => api.post('/menu', values),
        });

        if (saved) {
            notify.success('Dish created.');
            controller.load();
        }
    }

    async function editItem(item) {
        const saved = await openFormModal({
            title: `Edit ${item.name}`,
            submitLabel: 'Save changes',
            fields: [
                { name: 'name', label: 'Name', required: true, value: item.name },
                { name: 'description', label: 'Description', type: 'textarea', rows: 3, value: item.description || '' },
                { name: 'categoryId', label: 'Category', type: 'select', required: true, value: item.categoryId, options: categoryOptions() },
                { name: 'price', label: 'Price', type: 'number', min: 0.01, step: '0.01', value: item.price },
                { name: 'prepMinutes', label: 'Preparation minutes', type: 'number', min: 1, value: item.prepMinutes || '' },
                { name: 'isVegetarian', label: 'Vegetarian', type: 'checkbox', value: item.isVeg },
                { name: 'isSpicy', label: 'Spicy', type: 'checkbox', value: item.isSpicy },
                { name: 'isFeatured', label: 'Featured', type: 'checkbox', value: item.isFeatured },
                { name: 'isAvailable', label: 'Available', type: 'checkbox', value: item.isAvailable },
            ],
            run: (values) => api.patch(`/menu/${item.id}`, values),
        });

        if (saved) {
            notify.success('Dish updated.');
            controller.load();
        }
    }

    async function toggleAvailability(item) {
        const next = !item.isAvailable;
        try {
            await api.patch(`/menu/${item.id}/availability`, { isAvailable: next });
            notify.success(next ? `${item.name} is back on the menu.` : `${item.name} marked sold out.`);
            controller.load();
        } catch (error) {
            notify.error(error.message);
        }
    }

    async function removeItem(item) {
        const done = await confirmAndRun({
            title: `Delete ${item.name}?`,
            message: 'It will be removed from the menu. It can only be deleted if no past order refers to it.',
            confirmLabel: 'Delete dish',
            run: () => api.delete(`/menu/${item.id}`),
        });

        if (done) {
            notify.success('Dish deleted.');
            controller.load();
        }
    }

    await loadCategories();

    const categorySelect = content.querySelector('#filter-category');
    if (categorySelect) {
        for (const category of categories) {
            categorySelect.appendChild(createElement('option', { value: category.id, text: category.name }));
        }
    }

    await controller.load();
}
