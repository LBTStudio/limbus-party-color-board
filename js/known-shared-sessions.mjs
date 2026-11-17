const STORAGE_KEY = 'lpc-known-shared-sessions';
const MAX_KNOWN_SESSIONS = 8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readKnownSharedSessions(storage) {
  const target = resolveStorage(storage);
  if (!target) return [];
  try {
    const parsed = JSON.parse(target.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && UUID_PATTERN.test(String(item.session_id || '')))
      .slice(0, MAX_KNOWN_SESSIONS)
      .map((item) => ({
        session_id: String(item.session_id).toLowerCase(),
        title: String(item.title || '前回利用した共有スペース').trim().slice(0, 80)
          || '前回利用した共有スペース',
      }));
  } catch {
    return [];
  }
}

export function rememberKnownSharedSession(sessionId, title, storage) {
  const id = String(sessionId || '').trim();
  if (!UUID_PATTERN.test(id)) return false;
  const target = resolveStorage(storage);
  if (!target) return false;
  const normalizedId = id.toLowerCase();
  const record = {
    session_id: normalizedId,
    title: String(title || '共有スペース').trim().slice(0, 80) || '共有スペース',
  };
  const next = [
    record,
    ...readKnownSharedSessions(target).filter((item) => item.session_id !== normalizedId),
  ].slice(0, MAX_KNOWN_SESSIONS);
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function forgetKnownSharedSession(sessionId, storage) {
  const id = String(sessionId || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) return false;
  const target = resolveStorage(storage);
  if (!target) return false;
  try {
    const next = readKnownSharedSessions(target).filter((item) => item.session_id !== id);
    target.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
