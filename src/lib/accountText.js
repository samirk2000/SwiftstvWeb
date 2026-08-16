// Human-readable messages for account status problems. Mirrors the Roku
// loginAccountProblem messages (Spanish primary). Kept separate from the
// status enum so screens can show friendly text.

const MSGS_ES = {
  invalid: 'Usuario o contraseña inválidos, o la cuenta ya no existe.',
  expired: 'Tu suscripción ha expirado o la prueba ha finalizado.',
  banned: 'Esta cuenta fue suspendida.',
  disabled: 'Esta cuenta está deshabilitada, fue eliminada o no existe.',
  network: 'No se pudo conectar. Verifica tu internet.',
};

const MSGS_EN = {
  invalid: 'Invalid username or password, or the account no longer exists.',
  expired: 'Your subscription has expired or the trial has ended.',
  banned: 'This account has been suspended.',
  disabled: 'This account is disabled, was removed, or does not exist.',
  network: 'Could not connect. Check your internet.',
};

export function serverInfoLabel(status, lang = 'es') {
  const table = lang === 'en' ? MSGS_EN : MSGS_ES;
  return table[status] || table.invalid;
}
