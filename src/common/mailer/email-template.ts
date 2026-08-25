/**
 * The one branded HTML shell every Ralia email renders through — OTP codes and
 * notifications alike. Table-based with inline styles (the only thing email clients
 * reliably honour), no external assets, ~560px card, brand header + support footer.
 */

const BRAND = {
  red: '#F70909',
  dark: '#1a0304',
  ink: '#17110f',
  body: '#4b4b4b',
  muted: '#8a8a8a',
  line: '#ececec',
  wash: '#f4f4f5',
  logo: 'https://ralia.co/Ralia%20Logo.jpeg',
} as const;

const SUPPORT = {
  email: 'support@ralia.co',
  whatsapp: 'https://wa.me/2348139376563',
  terms: 'https://ralia.co/terms',
  privacy: 'https://ralia.co/privacy',
} as const;

/** Escape user- or data-derived text before it goes into the HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export type BrandedEmail = {
  /** Bold heading at the top of the body. */
  heading: string;
  /** Body paragraphs, plain text (escaped for you). */
  paragraphs?: string[];
  /** A large, letter-spaced code block (OTP). */
  code?: string;
  /** An optional call-to-action button. */
  cta?: { label: string; url: string };
  /** Hidden inbox-preview text. */
  preheader?: string;
};

export function renderBrandedEmail(opts: BrandedEmail): string {
  const { heading, paragraphs = [], code, cta, preheader } = opts;

  const paras = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BRAND.body}">${escapeHtml(p)}</p>`)
    .join('');

  const codeBlock = code
    ? `<div style="margin:4px 0 20px;text-align:center"><div style="display:inline-block;padding:16px 30px;background:#faf0f0;border:1px solid #f3d6d6;border-radius:12px;font-size:32px;font-weight:800;letter-spacing:8px;color:${BRAND.ink}">${escapeHtml(code)}</div></div>`
    : '';

  const ctaBlock = cta
    ? `<div style="margin:4px 0 8px"><a href="${encodeURI(cta.url)}" style="display:inline-block;background:${BRAND.red};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:999px">${escapeHtml(cta.label)}</a></div>`
    : '';

  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${BRAND.wash};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    ${pre}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.wash};padding:24px 0">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:92%;background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;overflow:hidden">
            <tr>
              <td style="background:#ffffff;padding:20px 32px;border-bottom:3px solid ${BRAND.red}">
                <img src="${BRAND.logo}" alt="Ralia" height="40" style="display:block;height:40px;width:auto;border:0;outline:none;text-decoration:none" />
              </td>
            </tr>
            <tr>
              <td style="padding:32px">
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:800;color:${BRAND.ink}">${escapeHtml(heading)}</h1>
                ${paras}${codeBlock}${ctaBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:22px 32px;border-top:1px solid ${BRAND.line};background:#fbfbfb">
                <p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${BRAND.muted}">
                  Need help? <a href="${SUPPORT.whatsapp}" style="color:${BRAND.red};text-decoration:none">Chat on WhatsApp</a>
                  or email <a href="mailto:${SUPPORT.email}" style="color:${BRAND.red};text-decoration:none">${SUPPORT.email}</a>.
                </p>
                <p style="margin:0;font-size:11px;line-height:1.6;color:${BRAND.muted}">
                  © Ralia ·
                  <a href="${SUPPORT.terms}" style="color:${BRAND.muted};text-decoration:underline">Terms</a> ·
                  <a href="${SUPPORT.privacy}" style="color:${BRAND.muted};text-decoration:underline">Privacy</a>
                </p>
              </td>
            </tr>
          </table>
          <div style="font-size:11px;color:${BRAND.muted};margin-top:14px">You're receiving this because you have a Ralia account.</div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
