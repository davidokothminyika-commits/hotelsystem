/**
 * public/js/pages/staff/messages.js
 *
 * WHAT THIS MODULE DOES
 * The staff inbox: a list of guest conversations and, beside it, the selected
 * thread with a reply box.
 *
 * WHY ONE PAGE SERVES BOTH THE STAFF AND ADMIN URLS
 * An administrator answers the same queue a receptionist does, only with wider
 * access, so there is nothing to configure differently. The page resolves its
 * own title from the signed-in role rather than the URL, which keeps the two
 * links in the sidebar pointing at one implementation.
 *
 * WHY REPLIES DO NOT RELOAD THE LIST
 * Sending a message appends it to the open thread in place. Reloading the whole
 * list would move the thread to the top and lose the scroll position, which
 * makes it impossible to hold a conversation with someone.
 *
 * COMMUNICATION
 * Page -> GET  /api/messages/inbox    (all conversations, staff view)
 *      -> GET  /api/messages/:id      (one thread)
 *      -> POST /api/messages/:id/messages
 *      -> PATCH /api/messages/:id/close
 * Database tables used: conversations, conversation_participants, messages
 */
import { buildShell } from '../../components/shell.js';
import { confirmAndRun } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showEmptyState,
    showSkeleton,
    formatDate,
} from '../../lib/dom.js';

const STAFF_ROLES = ['receptionist', 'manager', 'admin', 'restaurant_staff', 'housekeeping'];

const shell = await buildShell({
    title: 'Inbox',
    subtitle: 'Guest conversations',
    roles: STAFF_ROLES,
});

if (shell?.content) {
    const { user, content } = shell;

    const layout = createElement('div', {
        class: 'grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 h-[calc(100vh-190px)]',
    });
    content.appendChild(layout);

    // ---- Conversation list -------------------------------------------------
    const listPanel = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm flex flex-col overflow-hidden',
    });
    const listHead = createElement('header', {
        class: 'px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-2',
    }, [
        createElement('h2', { class: 'font-semibold text-stone-900', text: 'Conversations' }),
    ]);

    const refreshButton = createElement('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        'aria-label': 'Refresh conversations',
        html: '<i class="fa-solid fa-rotate" aria-hidden="true"></i>',
        onclick: () => loadConversations(),
    });
    listHead.appendChild(refreshButton);

    const conversationList = createElement('div', { class: 'flex-1 overflow-y-auto' });
    listPanel.append(listHead, conversationList);

    // ---- Thread -----------------------------------------------------------
    const threadPanel = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm flex flex-col overflow-hidden',
    });
    const threadHead = createElement('header', {
        class: 'px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-2',
    });
    const threadTitle = createElement('h2', { class: 'font-semibold text-stone-900 truncate', text: 'Select a conversation' });
    threadHead.appendChild(threadTitle);

    const threadBody = createElement('div', { class: 'flex-1 overflow-y-auto p-4 space-y-3' });

    const replyForm = createElement('form', { class: 'border-t border-stone-200 p-3 flex gap-2' });
    const replyInput = createElement('textarea', {
        class: 'form-textarea flex-1',
        rows: 2,
        placeholder: 'Write a reply...',
        'aria-label': 'Reply message',
    });
    const sendButton = createElement('button', {
        type: 'submit',
        class: 'btn btn-primary self-end',
        text: 'Send',
    });
    replyForm.append(replyInput, sendButton);
    replyForm.hidden = true;

    threadPanel.append(threadHead, threadBody, replyForm);

    layout.append(listPanel, threadPanel);

    // =====================================================================
    // State
    // =====================================================================
    let conversations = [];
    let activeId = null;

    async function loadConversations() {
        showSkeleton(conversationList, 4, 'h-16');
        conversationList.removeAttribute('aria-busy');

        try {
            const result = await api.get('/messages/inbox', { query: { limit: 50 } });
            conversations = result?.data || [];

            clear(conversationList);

            if (conversations.length === 0) {
                showEmptyState(conversationList, {
                    title: 'No conversations',
                    message: 'Guest messages will appear here.',
                    icon: 'fa-inbox',
                });
                return;
            }

            for (const conversation of conversations) {
                conversationList.appendChild(conversationRow(conversation));
            }

            // Keep the open thread selected across a refresh.
            if (activeId && conversations.some((c) => c.id === activeId)) {
                highlightActive();
            }
        } catch (error) {
            clear(conversationList);
            showEmptyState(conversationList, {
                title: 'Could not load conversations',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function conversationRow(conversation) {
        const row = createElement('button', {
            type: 'button',
            class: 'w-full text-left px-4 py-3 border-b border-stone-100 hover:bg-stone-50 transition',
            'data-id': String(conversation.id),
        });

        const top = createElement('div', { class: 'flex items-center justify-between gap-2 mb-1' });
        top.append(
            createElement('span', {
                class: 'font-medium text-stone-900 text-sm truncate',
                text: conversation.participants?.length
                    ? conversation.participants.join(', ')
                    : conversation.subject,
            }),
        );

        if (conversation.unreadCount > 0) {
            top.appendChild(
                createElement('span', {
                    class: 'badge badge-danger',
                    text: String(conversation.unreadCount),
                }),
            );
        }

        row.append(top);
        row.appendChild(
            createElement('p', {
                class: 'text-xs text-stone-500 truncate mb-1',
                text: conversation.lastMessage || conversation.subject,
            }),
        );
        row.appendChild(
            createElement('p', {
                class: 'text-[11px] text-stone-400',
                text: formatDate(conversation.lastMessageAt || conversation.createdAt),
            }),
        );

        row.addEventListener('click', () => openThread(conversation.id));

        return row;
    }

    function highlightActive() {
        for (const row of conversationList.querySelectorAll('[data-id]')) {
            const active = Number(row.dataset.id) === Number(activeId);
            row.classList.toggle('bg-amber-50', active);
            row.classList.toggle('border-l-2', active);
            row.classList.toggle('border-amber-600', active);
        }
    }

    async function openThread(id) {
        activeId = id;
        highlightActive();

        clear(threadBody);
        showSkeleton(threadBody, 3, 'h-12');
        threadBody.removeAttribute('aria-busy');
        replyForm.hidden = true;

        try {
            const result = await api.get(`/messages/${id}`);
            const conversation = result?.data?.conversation;
            const messages = result?.data?.messages || [];

            threadTitle.textContent = conversation?.subject || 'Conversation';

            // Replace any actions from the previously open thread, otherwise
            // "Close" and "Reopen" would both end up stacked in the header.
            threadHead.querySelector('#thread-actions')?.remove();

            const actions = createElement('div', { class: 'flex items-center gap-2' });
            actions.id = 'thread-actions';

            if (conversation?.isClosed) {
                actions.appendChild(
                    createElement('button', {
                        type: 'button',
                        class: 'btn btn-outline btn-sm',
                        html: '<i class="fa-solid fa-lock-open" aria-hidden="true"></i> Reopen',
                        onclick: () => setClosed(conversation, false),
                    }),
                );
            } else {
                actions.appendChild(
                    createElement('button', {
                        type: 'button',
                        class: 'btn btn-outline btn-sm',
                        html: '<i class="fa-solid fa-lock" aria-hidden="true"></i> Close',
                        onclick: () => setClosed(conversation, true),
                    }),
                );
            }

            threadHead.appendChild(actions);

            clear(threadBody);
            if (messages.length === 0) {
                showEmptyState(threadBody, {
                    title: 'No messages yet',
                    message: 'Start the conversation below.',
                    icon: 'fa-comment',
                });
            } else {
                for (const message of messages) {
                    threadBody.appendChild(bubble(message, user));
                }
                // Scroll to the newest message once it is in the DOM.
                threadBody.scrollTop = threadBody.scrollHeight;
            }

            replyForm.hidden = false;
            replyInput.focus();
        } catch (error) {
            clear(threadBody);
            showEmptyState(threadBody, {
                title: 'Could not open conversation',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    /** A message bubble, aligned by who sent it. */
    function bubble(message, viewer) {
        const own = Number(message.senderId) === Number(viewer?.id);

        const wrap = createElement('div', { class: own ? 'flex justify-end' : 'flex justify-start' });
        const box = createElement('div', {
            class: own
                ? 'max-w-[80%] rounded-lg rounded-br-sm bg-amber-600 text-white px-3 py-2'
                : 'max-w-[80%] rounded-lg rounded-bl-sm bg-stone-100 text-stone-800 px-3 py-2',
        });

        box.appendChild(createElement('p', { class: 'text-sm whitespace-pre-wrap break-words', text: message.body }));
        box.appendChild(
            createElement('p', {
                class: `text-[10px] mt-1 ${own ? 'text-amber-100' : 'text-stone-400'}`,
                text: `${own ? 'You' : message.senderName || 'Guest'} · ${formatDate(message.createdAt)}`,
            }),
        );

        wrap.appendChild(box);
        return wrap;
    }

    replyForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const body = replyInput.value.trim();
        if (!body || !activeId) return;

        sendButton.disabled = true;
        try {
            const result = await api.post(`/messages/${activeId}/messages`, { body });

            // Appended in place: reloading the list would reorder it and lose
            // the reader's position mid-conversation.
            const message = result?.data?.message;
            if (message) {
                threadBody.appendChild(bubble(message, user));
                threadBody.scrollTop = threadBody.scrollHeight;
            }

            replyInput.value = '';
            loadConversations();
        } catch (error) {
            notify.error(error.message);
        } finally {
            sendButton.disabled = false;
            replyInput.focus();
        }
    });

    async function setClosed(conversation, isClosed) {
        const done = await confirmAndRun({
            title: isClosed ? 'Close this conversation?' : 'Reopen this conversation?',
            message: isClosed
                ? 'It will be hidden from the active inbox. You can reopen it at any time.'
                : 'It will return to the active inbox.',
            confirmLabel: isClosed ? 'Close it' : 'Reopen it',
            variant: isClosed ? 'danger' : 'primary',
            run: () => api.patch(`/messages/${conversation.id}/close`, { isClosed }),
        });

        if (done) {
            notify.success(isClosed ? 'Conversation closed.' : 'Conversation reopened.');
            loadConversations();
            openThread(conversation.id);
        }
    }

    await loadConversations();
}
