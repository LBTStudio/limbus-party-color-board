// Escape untrusted text before inserting it into an HTML text or quoted-attribute context.
// Prefer textContent for DOM updates; use this only for the few template-based renderers.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}
