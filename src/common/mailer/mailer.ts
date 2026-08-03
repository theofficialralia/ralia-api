export const MAILER = Symbol('MAILER');

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/**
 * Pluggable outbound email — same shape in every environment. SMTP (mailpit) in dev,
 * a transactional provider in prod, a log/no-op when nothing is configured. Nothing
 * above this interface knows which is bound. A failed send throws so the dispatch
 * sweep can retry.
 */
export interface Mailer {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
}
