/**
 * src/services/mail.service.js
 *
 * WHAT THIS MODULE DOES
 * Sends transactional email: password reset links, email verification links,
 * booking confirmations and receipts.
 *
 * WHY IT EXISTS
 * Business rules should never depend on whether SMTP is configured. This
 * service always resolves successfully: if `MAIL_ENABLED=false` (the default)
 * it prints the message to the server console instead of sending it, so a
 * developer can complete a password reset flow on a machine with no mail
 * account.
 *
 * DEVELOPMENT MODE
 * The logged output includes a copy-pasteable URL. This is the intended way
 * to test password reset locally and must never be enabled in production,
 * where a real transporter is required.
 *
 * COMMUNICATION
 * Called by: services/auth.service.js, services/booking.service.js,
 *            services/payment.service.js.
 * Reads: config/env.js for SMTP settings.
 * Database tables used: none.
 */
import nodemailer from 'nodemailer';
import env from '../config/env.js';

/** Plain text and HTML shells so every email shares one look. */
function layout({ heading, body, action }) {
    const actionBlock = action
        ? `<p style="margin:28px 0">
             <a href="${action.url}"
                style="background:#b8860b;color:#1a1a1a;padding:12px 24px;border-radius:8px;
                       text-decoration:none;font-weight:600;display:inline-block">
               ${action.label}
             </a>
           </p>
           <p style="font-size:13px;color:#666;word-break:break-all">
             Or paste this link into your browser:<br>${action.url}
           </p>`
        : '';

    return `
    <div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#1a1a1a;color:#fff;padding:20px 28px;border-radius:12px 12px 0 0">
        <h1 style="margin:0;font-size:19px;letter-spacing:0.5px">${env.appName}</h1>
      </div>
      <div style="background:#fafaf9;padding:28px;border:1px solid #e7e5e4;border-top:0;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 14px;font-size:18px;color:#1c1917">${heading}</h2>
        ${body}
        ${actionBlock}
        <hr style="border:0;border-top:1px solid #e7e5e4;margin:26px 0">
        <p style="font-size:12px;color:#78716c;margin:0">
          If you did not request this email you can safely ignore it.
        </p>
      </div>
    </div>`.trim();
}

/**
 * Creates the SMTP transport, or returns null when mail is disabled.
 *
 * A transport is only constructed when credentials are actually present, so
 * starting the app never fails because of an incomplete mail configuration.
 */
function createTransport() {
    if (!env.mail.enabled) return null;

    const options = {
        host: env.mail.host,
        port: env.mail.port,
        secure: env.mail.secure,
        // Blocks the transport from fetching remote files or URLs while
        // rendering a message, closing off an SSRF path in nodemailer.
        disableFileAccess: true,
        disableUrlAccess: true,
    };

    if (env.mail.user) {
        options.auth = { user: env.mail.user, pass: env.mail.password };
    }

    return nodemailer.createTransport(options);
}

// Built once and reused, because a transport is designed to be long lived.
const transport = createTransport();

const mailService = {
    /**
     * Low level send. Returns the transport result, or a development stub.
     * Never throws: a failed email must not roll back a completed booking.
     */
    async send({ to, subject, html, text }) {
        if (!transport) {
            // ---- DEVELOPMENT MODE ----
            console.log('\n' + '='.repeat(72));
            console.log(`[mail:dev] ${subject}`);
            console.log(`[mail:dev] To: ${to}`);
            const url = (html || '').match(/https?:\/\/[^\s"<]+/);
            if (url) {
                console.log(`[mail:dev] Action link (copy this):`);
                console.log(`[mail:dev]   ${url[0]}`);
            }
            console.log('='.repeat(72) + '\n');
            return { devMode: true, messageId: `dev-${Date.now()}` };
        }

        try {
            const info = await transport.sendMail({
                from: `"${env.mail.fromName}" <${env.mail.fromAddress}>`,
                to,
                subject,
                text,
                html,
            });
            return { devMode: false, messageId: info.messageId };
        } catch (error) {
            // Log and swallow. The user action that triggered the email has
            // already succeeded in the database.
            console.error(`[mail] Failed to send "${subject}" to ${to}:`, error.message);
            return { devMode: false, sent: false, error: error.message };
        }
    },

    async sendPasswordReset({ to, name, resetUrl, expiresInMinutes }) {
        return this.send({
            to,
            subject: 'Reset your password',
            text: `Hello ${name},\n\nReset your password using this link (valid ${expiresInMinutes} minutes):\n${resetUrl}\n\nIf you did not request a password reset, ignore this email.`,
            html: layout({
                heading: 'Reset your password',
                body: `<p style="color:#444;line-height:1.6">Hello ${name},</p>
                       <p style="color:#444;line-height:1.6">
                         Use the button below to choose a new password. This link expires in
                         <strong>${expiresInMinutes} minutes</strong> and can only be used once.
                       </p>`,
                action: { url: resetUrl, label: 'Reset password' },
            }),
        });
    },

    async sendEmailVerification({ to, name, verificationUrl }) {
        return this.send({
            to,
            subject: 'Verify your email address',
            text: `Hello ${name},\n\nVerify your email address using this link:\n${verificationUrl}`,
            html: layout({
                heading: 'Confirm your email address',
                body: `<p style="color:#444;line-height:1.6">Hello ${name},</p>
                       <p style="color:#444;line-height:1.6">
                         Confirm this address to secure your account and receive booking
                         confirmations directly.
                       </p>`,
                action: { url: verificationUrl, label: 'Verify email' },
            }),
        });
    },

    async sendBookingConfirmation({ to, name, booking }) {
        const detailsUrl = `${env.appUrl}/pages/guest/booking-details.html?id=${booking.id}`;
        return this.send({
            to,
            subject: `Booking confirmed: ${booking.bookingReference}`,
            text: `Hello ${name},\n\nYour booking ${booking.bookingReference} is confirmed.\nRoom ${booking.roomNumber}, ${booking.checkIn} to ${booking.checkOut}.\nTotal: ${booking.totalAmount} ${booking.currency}.`,
            html: layout({
                heading: `Booking ${booking.bookingReference} confirmed`,
                body: `<table style="width:100%;font-size:14px;color:#444;border-collapse:collapse">
                        <tr><td style="padding:6px 0;color:#78716c">Room</td>
                            <td style="padding:6px 0;font-weight:600">${booking.roomNumber}</td></tr>
                        <tr><td style="padding:6px 0;color:#78716c">Check-in</td>
                            <td style="padding:6px 0;font-weight:600">${booking.checkIn}</td></tr>
                        <tr><td style="padding:6px 0;color:#78716c">Check-out</td>
                            <td style="padding:6px 0;font-weight:600">${booking.checkOut}</td></tr>
                        <tr><td style="padding:6px 0;color:#78716c">Total</td>
                            <td style="padding:6px 0;font-weight:600">${booking.totalAmount} ${booking.currency}</td></tr>
                       </table>`,
                action: { url: detailsUrl, label: 'View booking' },
            }),
        });
    },

    async sendPaymentReceipt({ to, name, payment }) {
        return this.send({
            to,
            subject: `Payment receipt: ${payment.paymentReference}`,
            text: `Hello ${name},\n\nWe received your payment of ${payment.amount} ${payment.currency} (reference ${payment.paymentReference}).`,
            html: layout({
                heading: 'Payment received',
                body: `<p style="color:#444;line-height:1.6">Hello ${name},</p>
                       <p style="color:#444;line-height:1.6">
                         We received your payment of
                         <strong>${payment.amount} ${payment.currency}</strong>
                         via ${payment.paymentMethod.replace('_', ' ')}.
                       </p>
                       <p style="color:#78716c;font-size:13px">Reference: ${payment.paymentReference}</p>`,
                action: {
                    url: `${env.appUrl}/pages/guest/invoices.html?id=${payment.invoiceId}`,
                    label: 'View receipt',
                },
            }),
        });
    },
};

export default mailService;