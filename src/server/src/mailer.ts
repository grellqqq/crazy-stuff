/**
 * Transactional email via Gmail SMTP (nodemailer). Used for password reset
 * (auth GDD §3.10). Configured from env:
 *   SMTP_USER — the Gmail address that sends mail
 *   SMTP_PASS — a Gmail App Password (NOT the account password)
 *   MAIL_FROM — optional display sender (defaults to SMTP_USER)
 *
 * If SMTP isn't configured, sends are a no-op that LOG the link — so the reset
 * flow is fully testable in dev without real email.
 */
import nodemailer from 'nodemailer';

const SMTP_USER = process.env.SMTP_USER ?? '';
const SMTP_PASS = process.env.SMTP_PASS ?? '';
const MAIL_FROM = process.env.MAIL_FROM ?? SMTP_USER;

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;

export function mailerConfigured(): boolean {
  return transporter !== null;
}

export async function sendPasswordResetEmail(to: string, link: string): Promise<void> {
  if (!transporter) {
    console.log(`[mailer] SMTP not configured — password-reset link for ${to}:\n  ${link}`);
    return;
  }
  await transporter.sendMail({
    from: `Crazy Stuff <${MAIL_FROM}>`,
    to,
    subject: 'Reset your Crazy Stuff password',
    text:
      `Someone requested a password reset for your Crazy Stuff account.\n\n` +
      `Reset it here (the link expires in 1 hour):\n${link}\n\n` +
      `If you didn't request this, ignore this email — your password won't change.`,
    html:
      `<p>Someone requested a password reset for your Crazy Stuff account.</p>` +
      `<p><a href="${link}">Reset your password</a> — the link expires in 1 hour.</p>` +
      `<p style="color:#888;font-size:12px">If you didn't request this, ignore this email — your password won't change.</p>`,
  });
}
