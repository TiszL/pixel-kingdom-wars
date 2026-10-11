/**
 * Branded HTML templates for the two closed-alpha mails, alongside the plain
 * text that remains the deliverability workhorse (Resend gets BOTH — clients
 * that block HTML or images still read the text part verbatim).
 *
 * Email-HTML discipline (this is not the web): table layout, inline styles,
 * bgcolor attributes, no external CSS, no webfonts — "pixel" is evoked with a
 * monospace stack and hard 2px black borders, not Press Start 2P. The crest
 * image is hosted on the landing site and is decorative: every critical fact
 * (the code, the links) is text, because Gmail hides images until the user
 * opts in. Buttons are the bulletproof table+bgcolor pattern with a plain-URL
 * fallback line underneath.
 */

const SITE_URL = 'https://pixelkingdomwars.com';
/** Wave-2 owner profile mark. The former icon-192 route was removed from the
 * landing pack and left every HTML email with a broken image. */
const CREST_URL = `${SITE_URL}/assets/img/pkw-profile-512.png?v=1c8d0b13`;

const GOLD = '#E3AE3C';
const GOLD_HI = '#F4D77B';
const INK = '#100E14';
const PANEL = '#1A171E';
const CREAM = '#F7F2E4';
const DIM = '#8F8A98';

const MONO = "'Courier New',Courier,monospace";

const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Shared shell: dark realm backdrop, crest, gold rule, content card, footer. */
function shell(contentHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${INK};" bgcolor="${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${INK}" style="background-color:${INK};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
    <tr><td align="center" style="padding:0 0 18px;">
      <img src="${CREST_URL}" width="72" height="72" alt="" style="display:block;image-rendering:pixelated;">
    </td></tr>
    <tr><td align="center" style="padding:0 0 6px;font-family:${MONO};font-size:22px;font-weight:bold;letter-spacing:4px;color:${GOLD_HI};">
      PIXEL KINGDOM WARS
    </td></tr>
    <tr><td align="center" style="padding:0 0 26px;font-family:${MONO};font-size:12px;letter-spacing:3px;color:${DIM};">
      PLAYTEST
    </td></tr>
    <tr><td style="border-top:2px solid ${GOLD};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td bgcolor="${PANEL}" style="background-color:${PANEL};border:2px solid #000000;padding:30px 28px;">
      ${contentHtml}
    </td></tr>
    <tr><td align="center" style="padding:24px 16px 0;font-family:${MONO};font-size:11px;line-height:1.7;color:${DIM};">
      The playtest runs on Solana devnet — free to play, and nothing in it is real money.<br>
      <a href="${SITE_URL}" style="color:${DIM};text-decoration:underline;">pixelkingdomwars.com</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

/** Bulletproof gold button + plain-URL fallback line. */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:22px auto 0;">
    <tr><td bgcolor="${GOLD}" style="background-color:${GOLD};border:2px solid #000000;">
      <a href="${esc(href)}" style="display:inline-block;padding:15px 30px;font-family:${MONO};font-size:15px;font-weight:bold;letter-spacing:1px;color:${INK};text-decoration:none;">&#9654;&nbsp; ${label}</a>
    </td></tr>
  </table>
  <p style="margin:12px 0 0;text-align:center;font-family:${MONO};font-size:11px;color:${DIM};word-break:break-all;">
    or open: <a href="${esc(href)}" style="color:${GOLD};text-decoration:underline;">${esc(href)}</a>
  </p>`;
}

export function applicationReceivedEmail(): { subject: string; text: string; html: string } {
  const subject = 'Pixel Kingdom Wars — application received';
  const text =
    'Thanks for applying to the Pixel Kingdom Wars playtest.\n\n'
    + 'We review applications in batches. When a spot opens, a one-time invite '
    + 'code arrives at this address with instructions.\n\n'
    + 'The playtest runs on Solana devnet: everything in it is free, and nothing '
    + 'in it is real money.\n\n'
    + '— Pixel Kingdom Wars';
  const html = shell(`
      <h1 style="margin:0;font-family:${MONO};font-size:19px;line-height:1.5;color:${GOLD_HI};">Your banner has been raised.</h1>
      <p style="margin:16px 0 0;font-family:${MONO};font-size:14px;line-height:1.8;color:${CREAM};">
        Thanks for applying to the <b style="color:${GOLD_HI};">playtest</b>.
        We review applications in batches — when a spot opens, a one-time
        invite code arrives at this address with instructions.
      </p>
      <p style="margin:16px 0 0;font-family:${MONO};font-size:14px;line-height:1.8;color:${CREAM};">
        Until then, the realm waits.
      </p>
      ${button(SITE_URL, 'VISIT THE REALM')}`);
  return { subject, text, html };
}

export function accessGrantedEmail(codeFormatted: string, playUrl: string): { subject: string; text: string; html: string } {
  const subject = "You're in — your Pixel Kingdom Wars invite code";
  const text =
    'Welcome to the Pixel Kingdom Wars playtest.\n\n'
    + `Your one-time invite code:\n\n    ${codeFormatted}\n\n`
    + 'How to redeem it:\n'
    + `1. Open ${playUrl}\n`
    + '2. Sign in with any Solana wallet, or with Google / X / email.\n'
    + '3. Enter the code when the game asks for it.\n\n'
    + 'The code is single-use: it unlocks the first account that redeems it, '
    + 'permanently — keep it to yourself.\n\n'
    + 'The playtest runs on Solana devnet: free to play, your wallet is funded '
    + 'with free devnet SOL in-game, and nothing in it is real money.\n\n'
    + '— Pixel Kingdom Wars';
  const html = shell(`
      <h1 style="margin:0;font-family:${MONO};font-size:19px;line-height:1.5;color:${GOLD_HI};">The gates open for you.</h1>
      <p style="margin:16px 0 0;font-family:${MONO};font-size:14px;line-height:1.8;color:${CREAM};">
        Welcome to the <b style="color:${GOLD_HI};">playtest</b>. Your
        one&#8209;time invite code:
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
        <tr><td align="center" bgcolor="${INK}" style="background-color:${INK};border:2px solid ${GOLD};padding:20px 10px;font-family:${MONO};font-size:24px;font-weight:bold;letter-spacing:6px;color:${GOLD_HI};">
          ${esc(codeFormatted)}
        </td></tr>
      </table>
      ${button(playUrl, 'ENTER THE REALM')}
      <p style="margin:22px 0 0;font-family:${MONO};font-size:13px;line-height:1.9;color:${CREAM};">
        1. Open the game with the button above.<br>
        2. Sign in with any Solana wallet, or with Google&nbsp;/&nbsp;X&nbsp;/&nbsp;email.<br>
        3. Enter the code when the game asks for it.
      </p>
      <p style="margin:16px 0 0;font-family:${MONO};font-size:12px;line-height:1.8;color:${DIM};">
        The code is single-use: it unlocks the first account that redeems it,
        permanently — keep it to yourself.
      </p>`);
  return { subject, text, html };
}
