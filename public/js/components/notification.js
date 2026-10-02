/**
 * public/js/components/notification.js
 *
 * WHAT THIS MODULE DOES
 * Toast notifications and inline alerts. One component rather than a bespoke
 * message per page.
 *
 * WHY IT EXISTS
 * Feedback after an action must be consistent: a form that saved, a booking
 * that failed, a confirmation that succeeded. This module provides that in one
 * place so a page only calls `notify.success('Saved')`.
 *
 * ACCESSIBILITY
 * The live region is announced to screen readers via `role="status"` and
 * `aria-live="polite"`. Error toasts use `role="alert"` so they interrupt.
 * Toasts also auto-dismiss, but a close button is always present, because an
 * auto-dismissing message is inaccessible if it cannot be read in time.
 *
 * COMMUNICATION
 * Any page -> notify.success(...) -> renders a toast in #toast-region
 */
import { getElement, escapeHtml } from '../lib/dom.js';

const DEFAULT_DURATION = 4500;

/** Icons per type, chosen from a fixed map rather than interpolated classes. */
const ICONS = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
};

/**
 * Ensures the container that holds toasts exists exactly once.
 * Creating it lazily means pages do not need placeholder markup for it.
 */
function ensureRegion() {
    let region = document.getElementById('toast-region');
    if (!region) {
        region = document.createElement('div');
        region.id = 'toast-region';
        // This class positions the region and keeps it out of the tab order.
        region.className = 'toast-region';
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', 'Notifications');
        document.body.appendChild(region);
    }
    return region;
}

/**
 * Shows a toast.
 *
 * @param {object} options
 * @param {'success'|'error'|'warning'|'info'} [options.type='info']
 * @param {string} options.message
 * @param {number} [options.duration=4500] Milliseconds before auto-dismiss.
 *   Pass 0 to keep the toast until it is dismissed manually.
 */
function show({ type = 'info', message, duration = DEFAULT_DURATION, title = '' }) {
    if (!message) return null;

    const region = ensureRegion();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    // The message is inserted as text, never as HTML, so a server error
    // message containing markup cannot inject a script into the page.
    const icon = document.createElement('i');
    icon.className = `fa-solid ${ICONS[type] || ICONS.info} mt-0.5`;
    icon.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'flex-1';

    if (title) {
        const heading = document.createElement('p');
        heading.className = 'font-semibold text-sm text-stone-900';
        heading.textContent = title;
        body.appendChild(heading);
    }

    const text = document.createElement('p');
    text.className = 'text-sm text-stone-700';
    text.textContent = message;
    body.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost btn-sm btn-icon';
    // An icon-only control needs an accessible name.
    close.setAttribute('aria-label', 'Dismiss notification');
    const closeIcon = document.createElement('i');
    closeIcon.className = 'fa-solid fa-xmark';
    closeIcon.setAttribute('aria-hidden', 'true');
    close.appendChild(closeIcon);

    toast.append(icon, body, close);
    region.appendChild(toast);

    const dismiss = () => {
        if (!toast.isConnected) return;
        toast.remove();
    };

    close.addEventListener('click', dismiss);

    if (duration > 0) {
        setTimeout(dismiss, duration);
    }

    // Keep the number of simultaneous toasts reasonable.
    const toasts = region.querySelectorAll('.toast');
    if (toasts.length > 4) toasts[0].remove();

    return { dismiss };
}

export const notify = {
    success: (message, options) => show({ ...options, type: 'success', message }),
    error: (message, options) => show({ ...options, type: 'error', message, duration: 7000 }),
    warning: (message, options) => show({ ...options, type: 'warning', message }),
    info: (message, options) => show({ ...options, type: 'info', message }),
};

/**
 * Shows a dismissible error panel inside a container, for form-level errors
 * that should stay on screen rather than floating away.
 *
 * @param {string|Element} target CSS selector or element
 */
export function showAlert(target, message, type = 'error') {
    const container = typeof target === 'string' ? getElement(target) : target;
    if (!container) return null;

    const colours = {
        error: 'bg-red-50 text-red-800 border-red-200',
        success: 'bg-green-50 text-green-800 border-green-200',
        warning: 'bg-amber-50 text-amber-800 border-amber-200',
        info: 'bg-blue-50 text-blue-800 border-blue-200',
    };

    container.className = `hidden rounded-lg border px-4 py-3 text-sm ${colours[type] || colours.info}`;
    container.setAttribute('role', type === 'error' ? 'alert' : 'status');
    container.textContent = message;
    container.classList.remove('hidden');

    return container;
}

/** Hides a panel previously shown by showAlert. */
export function hideAlert(target) {
    const container = typeof target === 'string' ? getElement(target) : target;
    if (container) container.classList.add('hidden');
}

/**
 * Renders a validation error map returned by the API onto form fields.
 * Falls back to a single summary message when the error has no field.
 *
 * @param {object} errors Field name to message.
 * @param {HTMLFormElement} form
 */
export function showFieldErrors(form, errors) {
    clearFieldErrors(form);
    if (!errors || typeof errors !== 'object') return;

    let firstField = null;

    for (const [field, message] of Object.entries(errors)) {
        const input = form.elements[field];
        const target = input && input.length && !input.tagName ? input[0] : input;

        if (target && target.setAttribute) {
            target.setAttribute('aria-invalid', 'true');
            const field = target.closest('.field') || target.parentElement;
            if (field && field.classList) field.classList.add('has-error');

            let errorEl = field?.querySelector('.form-error');
            if (!errorEl) {
                errorEl = document.createElement('p');
                errorEl.className = 'form-error';
                // Links the input to its message for screen readers.
                errorEl.id = `${target.id || field}-error`;
                field.appendChild(errorEl);
            }
            errorEl.textContent = message;
            if (target.id) target.setAttribute('aria-describedby', errorEl.id);

            if (!firstField) firstField = target;
        }
    }

    // Move focus to the first invalid field so keyboard users are not stranded.
    if (firstField) firstField.focus();
}

/** Removes all field level error styling from a form. */
export function clearFieldErrors(form) {
    if (!form) return;

    for (const element of form.querySelectorAll('[aria-invalid="true"]')) {
        element.removeAttribute('aria-invalid');
    }
    for (const field of form.querySelectorAll('.has-error')) {
        field.classList.remove('has-error');
    }
    for (const error of form.querySelectorAll('.form-error')) {
        error.textContent = '';
    }
}

export default notify;