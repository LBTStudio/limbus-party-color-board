import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, TURNSTILE_SITE_KEY } from './supabase-config.mjs';

const PLACEHOLDER_KEY = 'REPLACE_WITH_SUPABASE_PUBLISHABLE_KEY';
const TURNSTILE_PLACEHOLDER = 'REPLACE_WITH_CLOUDFLARE_TURNSTILE_SITE_KEY';
let clientPromise;
let captchaToken = '';

export function isTurnstileConfigured() {
  return Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SITE_KEY !== TURNSTILE_PLACEHOLDER);
}

export function setCaptchaToken(token) {
  captchaToken = typeof token === 'string' ? token : '';
}

export function isCaptchaReady() {
  return Boolean(captchaToken);
}

function isPrivilegedKey(key) {
  const value = String(key || '').trim();
  const lower = value.toLowerCase();
  if (lower.startsWith('sb_secret_') || lower.includes('service_role') || lower.includes('secret')) return true;
  // Legacy anon/service_role keys are JWTs. Reject a privileged role if one was pasted by mistake.
  const payload = value.split('.')[1];
  if (!payload || typeof atob !== 'function') return false;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const decoded = JSON.parse(json);
    return decoded.role === 'service_role' || decoded.role === 'supabase_admin';
  } catch {
    return false;
  }
}

export function isSharedSessionsConfigured() {
  return Boolean(
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
    && SUPABASE_PUBLISHABLE_KEY
    && SUPABASE_PUBLISHABLE_KEY !== PLACEHOLDER_KEY
    && !isPrivilegedKey(SUPABASE_PUBLISHABLE_KEY),
  );
}

async function getClient() {
  if (!isSharedSessionsConfigured()) {
    throw new Error('Supabase の publishable key が未設定です。js/supabase-config.mjs を設定してください。');
  }
  if (!clientPromise) {
    clientPromise = import('https://esm.sh/@supabase/supabase-js@2.118.0?target=es2022').then(({ createClient }) => (
      createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
        global: {
          headers: { 'x-application-name': 'limbus-party-color-board' },
        },
      })
    )).catch((error) => {
      clientPromise = null;
      throw new Error(`Supabase client を読み込めませんでした: ${error.message}`);
    });
  }
  return clientPromise;
}

async function rpc(name, args = {}, displayName = '') {
  const client = await getClient();
  const { data: authData, error: authError } = await client.auth.getSession();
  if (authError) throw authError;
  if (!authData.session) {
    const captchaRequired = isTurnstileConfigured();
    const token = captchaToken;
    if (captchaRequired && !token) {
      throw new Error('不正利用防止の確認が必要です。Turnstile を完了してから、もう一度操作してください。');
    }
    let signInError;
    try {
      const { error } = await client.auth.signInAnonymously({
        options: {
          ...(displayName ? { data: { display_name: displayName.slice(0, 40) } } : {}),
          ...(token ? { captchaToken: token } : {}),
        },
      });
      signInError = error;
    } finally {
      captchaToken = '';
      if (captchaRequired && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('supabase-captcha-reset'));
      }
    }
    if (signInError) {
      if (/anonymous|disabled|signups not allowed/i.test(signInError.message)) {
        throw new Error('Supabase の匿名ログインが有効ではありません。Authentication 設定で Anonymous Sign-Ins を有効にしてください。');
      }
      if (/captcha/i.test(signInError.message)) {
        throw new Error('CAPTCHA の検証に失敗しました。確認をやり直してください。');
      }
      throw signInError;
    }
  }
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const translated = new Error(error.message || `RPC ${name} failed`);
    translated.code = error.code;
    throw translated;
  }
  return data;
}

export function createSharedSessions() {
  return {
    async readPublicSession(sessionId, { force = false } = {}) {
      const cacheKey = 'lpc-public-session:' + String(sessionId);
      if (!force && typeof sessionStorage !== 'undefined') {
        try {
          const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
          if (cached && Date.now() - cached.savedAt < 60000 && cached.data?.status === 'ok') {
            return { ...cached.data, role: 'public-viewer', _fromCache: true };
          }
        } catch { /* Ignore malformed or unavailable session cache. */ }
      }
      const client = await getClient();
      const { data, error } = await client.rpc('read_public_party_session', { p_session_id: sessionId });
      if (error) {
        const translated = new Error(error.message || '公開編成を読み込めませんでした。');
        translated.code = error.code;
        throw translated;
      }
      if (data?.status === 'ok' && typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), data: { ...data, role: 'public-viewer' } }));
        } catch { /* Cache is optional and must not block viewing. */ }
      }
      return data;
    },
    async joinPublicSession(sessionId, displayName) {
      return rpc('join_public_party_session', {
        p_session_id: sessionId,
        p_display_name: String(displayName || '参加者').slice(0, 40),
      }, displayName);
    },
    async setPublicAccess(sessionId, publicViewEnabled, publicEditEnabled) {
      return rpc('set_public_party_access', {
        p_session_id: sessionId,
        p_public_view_enabled: Boolean(publicViewEnabled),
        p_public_edit_enabled: Boolean(publicEditEnabled),
      });
    },
    async subscribeSession(sessionId, onChange, onStatus) {
      const client = await getClient();
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (!data.session) throw new Error('編集参加の認証が必要です。');
      await client.realtime.setAuth();
      const channel = client
        .channel('party:' + sessionId, { config: { private: true } })
        .on('broadcast', { event: 'party_changed' }, (message) => {
          onChange?.(message?.payload || message || {});
        })
        .subscribe((status, errorInfo) => onStatus?.(status, errorInfo));
      return channel;
    },
    async removeChannel(channel) {
      if (!channel || !clientPromise) return;
      const client = await getClient();
      await client.removeChannel(channel);
    },
    async listSessions(displayName) {
      return rpc('list_my_party_sessions', {}, displayName);
    },
    async createSession(title, displayName) {
      return rpc('create_party_session', { p_title: title, p_display_name: displayName }, displayName);
    },
    async createInvite(sessionId, expiresHours = 168) {
      return rpc('create_party_invite', { p_session_id: sessionId, p_expires_hours: expiresHours });
    },
    async revokeInvite(inviteId) {
      return rpc('revoke_party_invite', { p_invite_id: inviteId });
    },
    async requestAccess(token, displayName) {
      return rpc('request_party_access', { p_token: token, p_display_name: displayName }, displayName);
    },
    async checkAccess(sessionId, displayName) {
      return rpc('check_my_party_access', { p_session_id: sessionId }, displayName);
    },
    async pollSession(sessionId, afterRevision = -1) {
      return rpc('poll_party_session', { p_session_id: sessionId, p_after_revision: afterRevision });
    },
    async applyParty(sessionId, expectedRevision, operationId, partyKeys, partyPersonas = [], operation = 'party_update') {
      return rpc('apply_party_edit_v2', {
        p_session_id: sessionId,
        p_expected_revision: expectedRevision,
        p_operation_id: operationId,
        p_party_keys: partyKeys,
        p_party_personas: Array.isArray(partyPersonas) ? partyPersonas : [],
        p_operation: operation,
      });
    },
    async getAdmin(sessionId) {
      return rpc('list_party_session_admin', { p_session_id: sessionId });
    },
    async decideRequest(requestId, decision, role = 'editor') {
      return rpc('decide_party_access_request', { p_request_id: requestId, p_decision: decision, p_role: role });
    },
    async removeMember(sessionId, userId) {
      return rpc('remove_party_session_member', { p_session_id: sessionId, p_user_id: userId });
    },
    async setMemberRole(sessionId, userId, role) {
      return rpc('set_party_session_member_role', { p_session_id: sessionId, p_user_id: userId, p_role: role });
    },
    async archiveSession(sessionId) {
      return rpc('archive_party_session', { p_session_id: sessionId });
    },
  };
}
