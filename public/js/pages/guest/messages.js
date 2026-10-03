/**
 * public/js/pages/guest/messages.js
 *
 * WHAT THIS MODULE DOES
 * The guest side of messaging: the guest's own threads, a reply box, and the
 * ability to start a new one with the front desk.
 *
 * WHY THE GUEST CANNOT CHOOSE A RECIPIENT
 * A guest picking "who am I talking to" would be a support request with a
 * dropdown attached. The service routes a new guest thread to staff
 * automatically, so the page only asks what the message is about.
 *
 * WHY REPLIES DO NOT RELOAD THE THREAD
 * Sending appends the message in place. Reloading would scroll a guest away from
 * the conversation they are reading, which is the one place scrolling matters.
 *
 * COMMUNICATION
 * Page -> GET  /api/messages                 (this guest's threads)
 *      -> GET  /api/messages/:id             (one thread)
 *      -> POST /api/messages                 (start a thread)
 *      -> POST /api/messages/:id/messages    (reply)
 * Database tables used: conversations, conversation_participants, messages
 */
import { buildShell, addHeaderAction } from '../../components/shell.js';
import { openFormModal } from '../../components/admin-ui.js';
import notify from '../../components/notification.js';
import api from '../../api/api.js';
import {
    createElement,
    clear,
    showEmptyState,
    showSkeleton,
    formatDate,
} from '../../lib/dom.js';

const CONTEXTS = [
    { value: 'support', label: 'General question' },
    { value: 'reception', label: 'My booking or stay' },
    { value: 'restaurant', label: 'My order' },
];

const shell = await buildShell({
    title: 'Messages',
    subtitle: 'Talk to the front desk',
});

if (shell?.content) {
    const { user, content } = shell;

    addHeaderAction({
        label: 'New message',
        icon: 'fa-pen-to-square',
        onClick: () => startConversation(),
    });

    const layout = createElement('div', {
        class: 'grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 h-[calc(100vh-190px)]',
    });
    content.appendChild(layout);

    // ---- Threads ----------------------------------------------------------
    const listPanel = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm flex flex-col overflow-hidden',
    });
    listPanel.append(
        createElement('header', { class: 'px-4 py-3 border-b border-stone-200' }, [
            createElement('h2', { class: 'font-semibold text-stone-900', text: 'Your messages' }),
        ]),
    );
    const threadList = createElement('div', { class: 'flex-1 overflow-y-auto' });
    listPanel.appendChild(threadList);

    // ---- Thread -----------------------------------------------------------
    const threadPanel = createElement('section', {
        class: 'bg-white rounded-xl border border-stone-200 shadow-sm flex flex-col overflow-hidden',
    });
    const threadHead = createElement('header', {
        class: 'px-4 py-3 border-b border-stone-200',
    }, [createElement('h2', { class: 'font-semibold text-stone-900', text: 'Select a message' })]);
    const threadBody = createElement('div', { class: 'flex-1 overflow-y-auto p-4 space-y-3' });

    const replyForm = createElement('form', { class: 'border-t border-stone-200 p-3 flex gap-2' });
    const replyInput = createElement('textarea', {
        class: 'form-textarea flex-1',
        rows: 2,
        placeholder: 'Write a reply...',
        'aria-label': 'Reply message',
    });
    const sendButton = createElement('button', { type: 'submit', class: 'btn btn-primary self-end', text: 'Send' });
    replyForm.append(replyInput, sendButton);
    replyForm.hidden = true;

    threadPanel.append(threadHead, threadBody, replyForm);
    layout.append(listPanel, threadPanel);

    let conversations = [];
    let activeId = null;

    async function loadThreads() {
        showSkeleton(threadList, 3, 'h-16');

        try {
            const result = await api.get('/messages');
            conversations = result?.data?.conversations || [];

            clear(threadList);

            if (conversations.length === 0) {
                showEmptyState(threadList, {
                    title: 'No messages',
                    message: 'Start a message and the front desk will reply.',
                    icon: 'fa-comments',
                });
                return;
            }

            for (const conversation of conversations) {
                threadList.appendChild(threadRow(conversation));
            }

            if (activeId && conversations.some((c) => c.id === activeId)) highlightActive();
        } catch (error) {
            clear(threadList);
            showEmptyState(threadList, {
                title: 'Could not load your messages',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function threadRow(conversation) {
        const row = createElement('button', {
            type: 'button',
            class: 'w-full text-left px-4 py-3 border-b border-stone-100 hover:bg-stone-50 transition',
            'data-id': String(conversation.id),
        });

        const top = createElement('div', { class: 'flex items-center justify-between gap-2 mb-1' });
        top.append(
            createElement('span', {
                class: 'font-medium text-stone-900 text-sm truncate',
                text: conversation.subject,
            }),
        );

        if (conversation.unreadCount > 0) {
            top.appendChild(createElement('span', { class: 'badge badge-danger', text: String(conversation.unreadCount) }));
        }

        row.append(
            top,
            createElement('p', {
                class: 'text-xs text-stone-500 truncate mb-1',
                text: conversation.lastMessage || 'No messages yet',
            }),
            createElement('p', {
                class: 'text-[11px] text-stone-400',
                text: formatDate(conversation.lastMessageAt || conversation.createdAt),
            }),
        );

        row.addEventListener('click', () => openThread(conversation.id));
        return row;
    }

    function highlightActive() {
        for (const row of threadList.querySelectorAll('[data-id]')) {
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
        showSkeleton(threadBody, 2, 'h-12');
        replyForm.hidden = true;

        try {
            const result = await api.get(`/messages/${id}`);
            const conversation = result?.data?.conversation;
            const messages = result?.data?.messages || [];

            threadHead.textContent = '';
            threadHead.appendChild(
                createElement('h2', { class: 'font-semibold text-stone-900', text: conversation?.subject || 'Message' }),
            );

            clear(threadBody);
            if (messages.length === 0) {
                showEmptyState(threadBody, {
                    title: 'No messages yet',
                    message: 'Write the first one below.',
                    icon: 'fa-comment',
                });
            } else {
                for (const message of messages) threadBody.appendChild(bubble(message));
                threadBody.scrollTop = threadBody.scrollHeight;
            }

            replyForm.hidden = false;
            replyInput.focus();
        } catch (error) {
            clear(threadBody);
            showEmptyState(threadBody, {
                title: 'Could not open this message',
                message: error.message,
                icon: 'fa-triangle-exclamation',
            });
        }
    }

    function bubble(message) {
        // The guest's own messages sit on the right, the hotel's on the left.
        const own = Number(message.senderId) === Number(user?.id);

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
                text: `${own ? 'You' : message.senderName || 'Hotel'} · ${formatDate(message.createdAt)}`,
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
            const message = result?.data?.message;
            if (message) {
                threadBody.appendChild(bubble(message));
                threadBody.scrollTop = threadBody.scrollHeight;
            }
            replyInput.value = '';
            loadThreads();
        } catch (error) {
            notify.error(error.message);
        } finally {
            sendButton.disabled = false;
            replyInput.focus();
        }
    });

    async function startConversation() {
        const saved = await openFormModal({
            title: 'Start a message',
            description: 'Your message goes to the front desk.',
            submitLabel: 'Send message',
            fields: [
                { name: 'subject', label: 'Subject', required: true, placeholder: 'What is this about?' },
                {
                    name: 'contextType',
                    label: 'About',
                    type: 'select',
                    required: true,
                    value: 'support',
                    options: CONTEXTS,
                },
                { name: 'openingMessage', label: 'Message', type: 'textarea', rows: 4, required: true },
            ],
            run: async (values) => {
                // The conversation is created first so the opening message has
                // somewhere to live; a thread created with no message is a
                // blank row the guest cannot tell apart from an unanswered one.
                const created = await api.post('/messages', {
                    subject: values.subject,
                    contextType: values.contextType,
                });
                const conversation = created?.data?.conversation;
                if (conversation?.id) {
                    await api.post(`/messages/${conversation.id}/messages`, { body: values.openingMessage });
                }
            },
        });

        if (saved) {
            notify.success('Message sent. The front desk will reply here.');
            loadThreads();
        }
    }

    await loadThreads();
}
