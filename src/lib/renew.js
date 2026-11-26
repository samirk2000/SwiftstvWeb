// Account renewal reminder (exp_date from the panel's user_info).
import { formatExpiry } from './time.js';

export const RENEW_WHATSAPP = '5216622684690';
// Same WhatsApp, written the way people dial it: +52 1 662 268 4690.
export const WHATSAPP_DISPLAY = RENEW_WHATSAPP.replace(/^(\d{2})(\d)(\d{3})(\d{3})(\d{4})$/, '+$1 $2 $3 $4 $5');
export const RENEW_WARN_DAYS = 5;
const DISMISS_KEY = 'swiftstv.renewDismissed.v1';

export function renewUrl(username) {
  const text = `Hola, quiero renovar mi cuenta Swift STV, usuario: ${String(username || '').trim()}`;
  return `https://wa.me/${RENEW_WHATSAPP}?text=${encodeURIComponent(text)}`;
}

/**
 * { expired, days, date } when the account expires within RENEW_WARN_DAYS
 * (or already expired), otherwise null. days = whole days left (0 = today).
 */
export function renewState(userInfo, nowMs = Date.now()) {
  if (!userInfo) return null;
  const status = String(userInfo.status || '').toLowerCase();
  const raw = userInfo.exp_date;
  const n = Number(raw);
  const hasDate = raw && raw !== '0' && Number.isFinite(n) && n > 0;
  const expired = status === 'expired' || (hasDate && n * 1000 <= nowMs);
  if (expired) return { expired: true, days: 0, date: hasDate ? formatExpiry(raw) : '' };
  if (!hasDate) return null;
  const msLeft = n * 1000 - nowMs;
  // Calendar days (so "vence mañana" is right even late at night).
  const end = new Date(n * 1000);
  const today = new Date(nowMs);
  const days = Math.round(
    (new Date(end.getFullYear(), end.getMonth(), end.getDate()) -
      new Date(today.getFullYear(), today.getMonth(), today.getDate())) /
      86400000,
  );
  if (msLeft > (RENEW_WARN_DAYS + 1) * 86400000 || days > RENEW_WARN_DAYS) return null;
  return { expired: false, days: Math.max(0, days), date: formatExpiry(raw) };
}

function todayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readDismissed() {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** True when the reminder for this user was already closed today. */
export function renewDismissedToday(username) {
  return readDismissed()[String(username || '').toLowerCase()] === todayKey();
}

export function dismissRenewToday(username) {
  try {
    const all = readDismissed();
    all[String(username || '').toLowerCase()] = todayKey();
    // Keep the map tiny.
    const keys = Object.keys(all);
    if (keys.length > 20) keys.slice(0, keys.length - 20).forEach((k) => delete all[k]);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}
