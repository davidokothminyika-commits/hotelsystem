/**
 * public/js/components/admin-ui.js
 *
 * WHAT THIS MODULE DOES
 * The shared scaffolding for every admin and staff screen: a data table, a
 * filter toolbar, a form modal, and a small controller that ties a list
 * endpoint to paging, filtering and search.
 *
 * WHY IT EXISTS
 * Fourteen of these screens are the same page with different columns and
 * different actions. Writing that loop fourteen times guarantees fourteen
 * subtly different bugs: one screen forgets to reset to page 1 when a filter
 * changes, another shows page 3 of results that now only have one page, a third
 * keeps the previous rows on screen while the next request is in flight. Putting
 * the loop in one place means those mistakes are made once, and fixed once.
 *
 * THE LIST CONTROLLER OWNS THE STATE
 * Page, limit, filters and search live in one object with one `load()`. Callers
 * change the state and call `load()`; they never call the API directly. That is
 * what keeps the table, the pager and the filter chips from disagreeing.
 *
 * XSS
 * Every cell value is inserted with textContent or escaped. Admin screens show
 * guest-supplied text (names, review comments, message bodies) to staff, so an
 * unescaped interpolation here would be stored XSS against the staff accounts.
 *
 * COMMUNICATION
 * Imported by: public/js/pages/admin/*.js and public/js/pages/staff/*.js
 * Uses: api/api.js, components/modal.js, components/notification.js, lib/dom.js
 */
import api from '../api/api.js';
import { openModal, confirmDialog } from './modal.js';
import notify from './notification.js';
import { pagination } from './cards.js';
import {
    createElement,
    clear,
    showSkeleton,
    showEmptyState,
    formatDate,
    setButtonLoading,
    escapeHtml,
    debounce,
} from '../lib/dom.js';

// =====================================================================
// Data table
// =====================================================================

/**
 * Builds a table shell. The caller fills the head and body.
 *
 * @param {object} options
 * @param {Array<{key:string,label:string,className?:string}>} options.columns
 * @param {boolean} [options.clickable=false] Highlights rows on hover.
 * @returns {{wrapper: HTMLElement, head: HTMLElement, body: HTMLElement, columns: Array}}
 */
export function createTable({ columns, clickable = false }) {
    const wrapper = createElement('div', {
        class: 'table-wrapper bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden',
    });

    const table = createElement('table', { class: `table${clickable ? ' table-clickable' : ''}` });

    const thead = createElement('thead');
    const headRow = createElement('tr');
    for (const column of columns) {
        headRow.appendChild(
            createElement('th', {
                class: column.className || '',
                text: column.label,
                scope: 'col',
            }),
        );
    }
    thead.appendChild(headRow);

    const tbody = createElement('tbody');
    table.append(thead, tbody);
    wrapper.appendChild(table);

    return { wrapper, head: headRow, body: tbody, columns };
}

/**
 * Fills a table body from rows using a column definition.
 *
 * @param {object} options
 * @param {HTMLElement} options.body      The tbody to fill.
 * @param {Array} options.rows
 * @param {Array<{key:string, render?:Function, className?:string, header?:string}>} options.columns
 *   A column with `render` gets the whole row and returns a node or string.
 *   Without one, the value at `key` is inserted as text.
 * @param {Function} [options.onRowClick] Makes each row activatable.
 * @param {object} [options.empty]        Empty state options.
 */
export function renderRows({ body, rows, columns, onRowClick, empty }) {
    clear(body);

    if (!rows || rows.length === 0) {
        // A table cannot show an empty state inside its tbody, so the whole
        // wrapper is replaced by the caller in most cases. Here we simply
        // render nothing and let the caller's own empty state take over.
        return false;
    }

    for (const row of rows) {
        const tr = createElement('tr');

        for (const column of columns) {
            let content;
            if (typeof column.render === 'function') {
                const rendered = column.render(row);
                content = rendered instanceof Node ? rendered : document.createTextNode(String(rendered ?? ''));
            } else {
                content = document.createTextNode(String(row[column.key] ?? ''));
            }

            tr.appendChild(createElement('td', { class: column.className || '' }, [content]));
        }

        if (onRowClick) {
            tr.classList.add('cursor-pointer');
            tr.tabIndex = 0;
            tr.addEventListener('click', () => onRowClick(row));
            // Keyboard users get the same affordance as a mouse click.
            tr.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onRowClick(row);
                }
            });
        }

        body.appendChild(tr);
    }

    return true;
}

// =====================================================================
// Toolbar
// =====================================================================

/**
 * A toolbar of controls above a table.
 *
 * @param {Array} controls Definitions built with `searchField`, `selectField`,
 *   `dateField` or `buttonField`.
 * @param {Function} [onChange] Called with the new value whenever a control changes.
 */
export function createToolbar(controls, onChange) {
    const bar = createElement('div', {
        class: 'flex flex-wrap items-end gap-3 mb-4 p-4 bg-white rounded-xl border border-stone-200 shadow-sm',
    });

    for (const control of controls) {
        const field = buildControl(control);
        if (!field) continue;

        // A search field reports on `input`, debounced, so typing does not fire
        // a request per keystroke. Everything else reports on `change`.
        if (control.type === 'search') {
            field.element.addEventListener(
                'input',
                debounce(() => onChange?.(control.name, readControl(control)), 350),
            );
        } else {
            field.element.addEventListener(control.event || 'change', () => {
                onChange?.(control.name, readControl(control));
            });
        }

        bar.appendChild(field.element);
    }

    return bar;
}

function readControl(control) {
    return control.read ? control.read() : control.element.value;
}

function buildControl(control) {
    if (control.type === 'search') {
        const wrapper = createElement('div', { class: 'flex-1 min-w-[220px]' });
        const input = createElement('input', {
            type: 'search',
            class: 'form-input',
            placeholder: control.placeholder || 'Search...',
            'aria-label': control.label || 'Search',
        });
        wrapper.appendChild(input);
        return { element: wrapper, read: () => input.value, input };
    }

    if (control.type === 'button') {
        return {
            element: createElement('button', {
                type: 'button',
                class: control.className || 'btn btn-outline',
                html: `${control.icon ? `<i class="fa-solid ${control.icon}" aria-hidden="true"></i>` : ''}${escapeHtml(control.label)}`,
                onclick: control.onClick,
            }),
            read: () => undefined,
        };
    }

    const wrapper = createElement('div', { class: control.wrapperClass || 'min-w-[160px]' });
    if (control.label) {
        wrapper.appendChild(
            createElement('label', {
                class: 'form-label',
                text: control.label,
                for: `filter-${control.name}`,
            }),
        );
    }

    let element;
    if (control.type === 'select') {
        element = createElement('select', { class: 'form-select', id: `filter-${control.name}` });
        for (const option of control.options || []) {
            element.appendChild(
                createElement('option', { value: option.value, text: option.label }),
            );
        }
    } else if (control.type === 'date') {
        element = createElement('input', {
            type: 'date',
            class: 'form-input',
            id: `filter-${control.name}`,
        });
    } else {
        element = createElement('input', {
            type: 'number',
            class: 'form-input',
            id: `filter-${control.name}`,
            placeholder: control.placeholder || '',
            min: control.min,
            max: control.max,
        });
    }

    wrapper.appendChild(element);
    return { element: wrapper, read: () => element.value, input: element };
}

// =====================================================================
// List controller
// =====================================================================

/**
 * Drives a paginated, filtered list.
 *
 * @param {object} options
 * @param {string} options.endpoint      e.g. '/bookings'
 * @param {HTMLElement} options.container Where the table and pager are rendered.
 * @param {object} [options.state]       Initial filter state.
 * @param {Function} options.render      (rows, helpers) => void, fills the table.
 * @param {object} [options.empty]       Empty state options.
 * @param {number} [options.limit=15]
 * @param {object} [options.extraQuery]  Extra query parameters sent with every request.
 * @returns {{load: Function, state: object, setFilter: Function, destroy: Function}}
 */
export function createListController({
    endpoint,
    container,
    state: initialState = {},
    render,
    empty = {},
    limit = 15,
    extraQuery = {},
}) {
    const state = { page: 1, limit, ...initialState };

    let destroyed = false;
    // Guards against a slow earlier request overwriting a newer one, which
    // otherwise shows stale rows after the user has already changed the filter.
    let requestToken = 0;

    const slot = createElement('div');
    const pagerSlot = createElement('div', { class: 'mt-4' });
    container.append(slot, pagerSlot);

    async function load() {
        const token = ++requestToken;
        showSkeleton(slot, 4, 'h-12');
        clear(pagerSlot);

        try {
            const query = Object.assign(
                { page: state.page, limit: state.limit },
                extraQuery,
            );

            // Empty strings would be sent as `?status=`; dropping them keeps the
            // URL clean and matches how the validators parse the value.
            for (const [key, value] of Object.entries(state)) {
                if (value === '' || value === null || value === undefined) continue;
                query[key] = value;
            }

            const result = await api.get(endpoint, { query });

            // A newer request has already started; this response is stale.
            if (token !== requestToken || destroyed) return;

            const rows = result?.data || [];
            const meta = result?.meta || {};

            if (rows.length === 0) {
                clear(slot);
                slot.appendChild(
                    createElement('div', { class: 'bg-white rounded-xl border border-stone-200 shadow-sm' }, []),
                );
                showEmptyState(slot.firstChild, empty);
                return;
            }

            clear(slot);
            // The slot is passed to the renderer rather than having the renderer
            // clear the container itself: clearing the container would also
            // destroy the pager, which is a sibling of the slot.
            render(rows, { meta, reload: load, slot });
            slot.firstChild?.removeAttribute('aria-busy');

            pagerSlot.appendChild(
                pagination({
                    page: Number(meta.page) || state.page,
                    totalPages: Number(meta.totalPages) || 1,
                    total: Number(meta.total) || rows.length,
                    onChange: (page) => {
                        state.page = page;
                        load();
                    },
                }),
            );
        } catch (error) {
            if (token !== requestToken || destroyed) return;

            const panel = createElement('div', {
                class: 'bg-white rounded-xl border border-stone-200 shadow-sm',
            });
            clear(slot);
            slot.appendChild(panel);
            showEmptyState(panel, {
                title: 'Could not load this list',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    /** Changes a filter and returns to page 1, which is what people expect. */
    function setFilter(name, value) {
        state[name] = value;
        state.page = 1;
        return load();
    }

    function destroy() {
        destroyed = true;
    }

    return { load, state, setFilter, destroy };
}

// =====================================================================
// Form modal
// =====================================================================

/**
 * Opens a modal containing a form.
 *
 * Field errors returned by the API are written next to their inputs rather
 * than shown as a toast, so the user can see what to fix without losing what
 * they typed.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {Array} options.fields  See `buildField`.
 * @param {Function} options.onSubmit  Receives the collected values; throw to reject.
 * @param {string} [options.submitLabel='Save']
 * @param {HTMLElement} [options.opener]
 * @returns {Promise<boolean>} Resolves true when saved, false when dismissed.
 */
export function openFormModal({ title, fields, onSubmit, submitLabel = 'Save', opener, description = '' }) {
    return new Promise((resolve) => {
        const form = createElement('form', { class: 'space-y-4', novalidate: true });

        for (const field of fields) {
            form.appendChild(buildField(field));
        }

        const errorSlot = createElement('div', { class: 'hidden' });

        const submit = createElement('button', {
            type: 'submit',
            class: 'btn btn-primary',
            text: submitLabel,
            form: 'admin-form',
        });

        const dialog = openModal({
            title,
            bodyNode: form,
            footerNode: createElement('div', { class: 'flex justify-end gap-2' }, [
                createElement('button', {
                    type: 'button',
                    class: 'btn btn-outline',
                    text: 'Cancel',
                    'data-modal-cancel': '',
                }),
                submit,
            ]),
            opener,
        });

        form.id = 'admin-form';
        form.appendChild(errorSlot);

        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        dialog.addEventListener('close', () => finish(false));

        // Collects values by field name, respecting each field's own reader.
        function collect() {
            const values = {};
            for (const field of fields) {
                if (field.type === 'group') {
                    // A checkbox group collects an array of the ticked values.
                    values[field.name] = [...form.querySelectorAll(`[data-group="${field.name}"]:checked`)].map(
                        (input) => input.value,
                    );
                    continue;
                }

                const input = form.querySelector(`[name="${field.name}"]`);
                if (!input) continue;
                if (field.type === 'checkbox') {
                    values[field.name] = input.checked;
                } else if (field.type === 'number') {
                    values[field.name] = input.value === '' ? null : Number(input.value);
                } else {
                    values[field.name] = input.value;
                }
            }
            return values;
        }

        /** Puts an API field error next to its input. */
        function paintErrors(errors) {
            form.querySelectorAll('[data-field-error]').forEach((node) => node.remove());
            form.querySelectorAll('[aria-invalid="true"]').forEach((node) =>
                node.removeAttribute('aria-invalid'),
            );

            for (const [name, message] of Object.entries(errors || {})) {
                const input = form.querySelector(`[name="${name}"]`);
                if (input) {
                    input.setAttribute('aria-invalid', 'true');
                    input.insertAdjacentElement(
                        'afterend',
                        createElement('p', {
                            class: 'form-error',
                            'data-field-error': '',
                            text: message,
                        }),
                    );
                } else {
                    // No matching input, so the message goes above the buttons
                    // rather than being dropped.
                    errorSlot.className = 'form-error';
                    errorSlot.textContent = message;
                }
            }
        }

        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            const values = collect();

            // Required-field checks happen here so the obvious mistakes never
            // cost a round trip.
            const missing = fields.filter(
                (field) =>
                    field.required &&
                    field.type !== 'group' &&
                    !String(values[field.name] ?? '').trim(),
            );
            if (missing.length) {
                paintErrors(
                    Object.fromEntries(missing.map((field) => [field.name, `${field.label} is required`])),
                );
                return;
            }

            // Clear the previous attempt's errors before showing this one's.
            paintErrors(null);
            errorSlot.className = 'hidden';
            setButtonLoading(submit, true, 'Saving...');

            try {
                await onSubmit(values);
                dialog.close();
                finish(true);
            } catch (error) {
                setButtonLoading(submit, false);
                if (error.errors) {
                    paintErrors(error.errors);
                } else {
                    notify.error(error.message);
                }
            }
        });

        dialog.querySelector('[data-modal-cancel]')?.addEventListener('click', () => dialog.close());
    });
}

/**
 * Builds one form field.
 *
 * @param {object} field
 * @param {string} field.name
 * @param {string} field.label
 * @param {'text'|'email'|'number'|'date'|'select'|'textarea'|'checkbox'|'password'} [field.type='text']
 */
export function buildField(field) {
    const id = `field-${field.name}`;
    const wrapper = createElement('div', { class: field.type === 'checkbox' ? 'flex items-center gap-2' : '' });

    // A fieldset of checkboxes, used for permission groups. The values are
    // collected as an array so a caller can send the ticked set in one go.
    if (field.type === 'group') {
        const group = createElement('fieldset', { class: 'border border-stone-200 rounded-lg p-3' });
        group.appendChild(
            createElement('legend', {
                class: 'text-sm font-medium text-stone-700 px-1',
                text: field.label,
            }),
        );

        const granted = new Set(field.granted || []);

        for (const item of field.items || []) {
            const row = createElement('label', {
                class: 'flex items-start gap-2 py-1 text-sm text-stone-600 cursor-pointer',
            });
            const box = createElement('input', {
                type: 'checkbox',
                value: item.value,
                class: 'mt-1',
                'data-group': field.name,
            });
            box.checked = granted.has(item.value);
            row.append(box, createElement('span', { text: item.label || item.value }));
            group.appendChild(row);
        }

        wrapper.appendChild(group);
        return wrapper;
    }

    if (field.type === 'checkbox') {
        const input = createElement('input', { type: 'checkbox', name: field.name, id });
        input.checked = Boolean(field.value);
        wrapper.append(input, createElement('label', { class: 'form-label mb-0', for: id, text: field.label }));
        return wrapper;
    }

    wrapper.appendChild(
        createElement('label', { class: 'form-label', for: id, text: field.label }),
    );

    let input;
    if (field.type === 'select') {
        input = createElement('select', { class: 'form-select', name: field.name, id });
        for (const option of field.options || []) {
            input.appendChild(createElement('option', { value: option.value, text: option.label }));
        }
        if (field.value !== undefined && field.value !== null) input.value = String(field.value);
    } else if (field.type === 'textarea') {
        input = createElement('textarea', {
            class: 'form-textarea',
            name: field.name,
            id,
            rows: field.rows || 4,
            placeholder: field.placeholder || '',
        });
        input.value = field.value ?? '';
    } else {
        input = createElement('input', {
            class: 'form-input',
            type: field.type || 'text',
            name: field.name,
            id,
            placeholder: field.placeholder || '',
            min: field.min,
            max: field.max,
            maxlength: field.maxlength,
            step: field.step,
        });
        input.value = field.value ?? '';
    }

    wrapper.appendChild(input);

    if (field.hint) {
        wrapper.appendChild(createElement('p', { class: 'form-hint', text: field.hint }));
    }

    return wrapper;
}

// =====================================================================
// Confirm + action helpers
// =====================================================================

/**
 * Runs a destructive action behind a confirmation dialog.
 *
 * The confirm happens before the request, never after: a refund or a deletion
 * must not be half-performed because a response failed.
 */
export async function confirmAndRun({ title, message, confirmLabel, variant, run }) {
    const confirmed = await confirmDialog({
        title,
        message,
        confirmLabel,
        variant: variant || 'danger',
    });

    if (!confirmed) return false;

    try {
        await run();
        return true;
    } catch (error) {
        notify.error(error.message);
        return false;
    }
}

/** A row of small action buttons, so every screen uses the same shapes. */
export function actionButtons(actions) {
    const wrap = createElement('div', { class: 'flex flex-wrap items-center gap-1 justify-end' });

    for (const action of actions.filter(Boolean)) {
        wrap.appendChild(
            createElement('button', {
                type: 'button',
                class: action.className || 'btn btn-ghost btn-sm',
                title: action.label,
                'aria-label': action.label,
                html: `<i class="fa-solid ${action.icon}" aria-hidden="true"></i>`,
                onclick: action.onClick,
            }),
        );
    }

    return wrap;
}

/** A date cell that falls back gracefully when the value is missing. */
export function dateCell(value) {
    return createElement('span', {
        class: 'text-sm text-stone-600',
        text: formatDate(value),
    });
}

/** An identity cell: name over email, for tables with a person in them. */
export function personCell(name, email) {
    const wrap = createElement('div', { class: 'min-w-0' });
    wrap.appendChild(createElement('p', { class: 'text-sm font-medium text-stone-900 truncate', text: name || '-' }));
    if (email) {
        wrap.appendChild(createElement('p', { class: 'text-xs text-stone-500 truncate', text: email }));
    }
    return wrap;
}

export default {
    createTable,
    renderRows,
    createToolbar,
    createListController,
    openFormModal,
    buildField,
    confirmAndRun,
    actionButtons,
    dateCell,
    personCell,
};
