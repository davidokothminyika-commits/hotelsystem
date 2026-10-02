/**
 * public/js/components/modal.js
 *
 * WHAT THIS MODULE DOES
 * Reusable modal dialogs: confirm prompts, forms and detail views.
 *
 * WHY THIS EXISTS
 * A modal needs focus management, Escape handling and scroll locking. Building
 * that once means every modal in the application is accessible, instead of
 * each page reimplementing it slightly differently and getting it wrong.
 *
 * WHY THE NATIVE <dialog> ELEMENT
 * `<dialog>` with `showModal()` handles the difficult parts natively:
 *   - focus moves into the dialog and is trapped there while it is open,
 *   - Escape closes it,
 *   - the rest of the page is inert to assistive technology,
 *   - `::backdrop` handles the dimmed background.
 * Implementing all of that by hand is a common source of accessibility bugs.
 *
 * COMMUNICATION
 * Pages -> modal.confirm(...) or openModal(...) -> renders into #modal-root
 */

/** Where modal markup is rendered. */
function getRoot() {
    let root = document.getElementById('modal-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'modal-root';
        document.body.appendChild(root);
    }
    return root;
}

/** Currently open dialogs, so Escape restores focus to the right element. */
let activeDialog = null;

/**
 * Creates a dialog element.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {string} [options.bodyHtml]  Markup for the body. Project-authored only.
 * @param {Node}   [options.bodyNode]  Preferred over bodyHtml for API data.
 * @param {string} [options.footerHtml] Markup for the action buttons.
 * @param {Node}   [options.footerNode] Preferred over footerHtml when the
 *   caller needs to keep a reference to a real element, such as a submit
 *   button that must be wired to live form state.
 * @param {'sm'|'lg'} [options.size='sm']
 * @returns {HTMLDialogElement}
 */
export function createDialog({ title, description, bodyHtml, bodyNode, footerHtml, footerNode, size = 'sm' }) {
    const dialog = document.createElement('dialog');
    dialog.className = `modal ${size === 'lg' ? 'modal-lg' : ''}`;
    dialog.setAttribute('aria-labelledby', 'modal-title');

    const panel = document.createElement('div');
    panel.className = 'modal-panel';

    // ---- Header ----
    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-4 p-5 border-b border-stone-200';

    const headingWrap = document.createElement('div');
    const heading = document.createElement('h2');
    heading.id = 'modal-title';
    heading.className = 'text-lg font-semibold text-stone-900';
    heading.textContent = title;
    headingWrap.appendChild(heading);

    if (description) {
        const descriptionEl = document.createElement('p');
        descriptionEl.className = 'mt-1 text-sm text-stone-500';
        descriptionEl.textContent = description;
        headingWrap.appendChild(descriptionEl);
    }

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'btn btn-ghost btn-icon';
    closeButton.setAttribute('aria-label', 'Close dialog');
    const closeIcon = document.createElement('i');
    closeIcon.className = 'fa-solid fa-xmark';
    closeIcon.setAttribute('aria-hidden', 'true');
    closeButton.appendChild(closeIcon);

    header.append(headingWrap, closeButton);

    // ---- Body ----
    const body = document.createElement('div');
    body.className = 'p-5';
    if (bodyNode) {
        body.appendChild(bodyNode);
    } else if (bodyHtml) {
        // Project-authored markup only. API data must arrive as text nodes.
        body.innerHTML = bodyHtml;
    }

    panel.append(header, body);

    // ---- Footer ----
    // A footerNode is preferred over footerHtml: it lets a caller supply a
    // real element (a submit button already wired to form state) instead of
    // markup that would then need to be found again in the DOM after opening.
    if (footerHtml || footerNode) {
        const footer = document.createElement('div');
        footer.className = 'flex flex-col-reverse sm:flex-row sm:justify-end gap-2 p-5 pt-0';

        if (footerNode) {
            footer.appendChild(footerNode);
        } else {
            footer.innerHTML = footerHtml;
        }

        panel.appendChild(footer);
    }

    dialog.appendChild(panel);

    // Stops a click on the dimmed backdrop from closing the dialog while a
    // click inside it should not.
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    closeButton.addEventListener('click', () => dialog.close());

    dialog.addEventListener('close', () => {
        // Return focus to whatever opened the dialog, so keyboard users are
        // not dropped back at the top of the page.
        if (activeDialog?.opener instanceof HTMLElement) activeDialog.opener.focus();
        dialog.remove();
        activeDialog = null;
    });

    return dialog;
}

/**
 * Opens a modal.
 *
 * @param {object} options See createDialog, plus:
 * @param {HTMLElement} [options.opener] Element that opened it, for focus return.
 * @returns {HTMLDialogElement} The open dialog.
 */
export function openModal(options) {
    const root = getRoot();

    // Only one modal at a time, so Escape and focus behave predictably.
    const existing = root.querySelector('dialog[open]');
    if (existing) existing.close();

    const dialog = createDialog(options);
    root.appendChild(dialog);
    dialog.showModal();

    // Move focus to the first meaningful control rather than the close button.
    const firstFocusable = dialog.querySelector(
        'input:not([type="hidden"]), select, textarea, button:not([aria-label="Close dialog"])',
    );
    (firstFocusable || closeButtonOf(dialog))?.focus();

    activeDialog = { dialog, opener: options.opener || document.activeElement };

    return dialog;
}

function closeButtonOf(dialog) {
    return dialog.querySelector('button[aria-label="Close dialog"]');
}

/**
 * Confirmation dialog. Resolves true when confirmed, false otherwise, so it
 * reads as a question the caller can await.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel='Confirm']
 * @param {string} [options.cancelLabel='Cancel']
 * @param {'danger'|'primary'} [options.variant='primary']
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'primary',
}) {
    return new Promise((resolve) => {
        const dialog = openModal({
            title,
            bodyHtml: `<p class="text-sm text-stone-600 leading-relaxed">${escapeText(message)}</p>`,
            footerHtml: `
                <button type="button" class="btn btn-outline" data-modal-cancel>${escapeText(cancelLabel)}</button>
                <button type="button" class="btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}" data-modal-confirm>
                    ${escapeText(confirmLabel)}
                </button>`,
        });

        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });

        dialog.querySelector('[data-modal-confirm]').addEventListener('click', () => {
            dialog.returnValue = 'confirm';
            dialog.close();
        });
        dialog.querySelector('[data-modal-cancel]').addEventListener('click', () => {
            dialog.returnValue = 'cancel';
            dialog.close();
        });
    });
}

/** Escapes text before it goes into the small amount of markup above. */
function escapeText(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

/**
 * Closes any open modal.
 */
export function closeModal() {
    const root = getRoot();
    root.querySelector('dialog[open]')?.close();
}

export default { openModal, confirmDialog, closeModal };