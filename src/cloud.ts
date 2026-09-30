import { googleProviderState, type ProviderState } from './auth-provider';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function cloudConfig(env: { VITE_SUPABASE_URL?: string; VITE_SUPABASE_PUBLISHABLE_KEY?: string }) {
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim(), raw = env.VITE_SUPABASE_URL?.trim();
  if (!raw && !key) return { client: null, notice: 'Прогресс сохраняется в этом браузере. Вход пока недоступен.' };
  try {
    const url = new URL(raw ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key ?? '')) throw Error('config');
    return { client: createClient(url.origin, key!, { auth: { flowType: 'pkce', detectSessionInUrl: false,
      persistSession: true, autoRefreshToken: true } }), checkGoogle: () => googleProviderState(url.origin, key!), notice: '' };
  } catch { return { client: null, notice: 'Прогресс сохраняется в этом браузере. Вход временно недоступен; можно заниматься без аккаунта.' }; }
}

export type AuthDiagnostic = 'none' | 'network' | 'provider' | 'callback' | 'session' | 'signout';
function authFailure(error: unknown, fallback: AuthDiagnostic): AuthDiagnostic {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['provider_disabled', 'validation_failed'].includes(code)) return 'provider';
  if (['bad_code_verifier', 'flow_state_expired', 'flow_state_not_found', 'bad_oauth_callback'].includes(code)) return 'callback';
  return error instanceof TypeError ? 'network' : fallback;
}
export type AuthView = { diagnostic?: AuthDiagnostic; busy: boolean; userId: string | null; text: string; canSignOut: boolean };
/** SDK owns tokens/verifier. The app only keeps transient identity and request generations. */
export class AuthController {
  diagnostic: AuthDiagnostic = 'none';
  private revision = 0;
  private started: Promise<void> | null = null;
  private subscription: { unsubscribe(): void } | null = null;
  private signingOut = false;
  private blocked = false;
  private disposed = false;
  private userId: string | null = null;
  private busy = false;
  private client: SupabaseClient | null;
  private identity: (id: string | null) => void;
  private view: (state: AuthView) => void;
  private notice: string;
  private checkGoogle: () => Promise<ProviderState>;
  constructor(client: SupabaseClient | null, identity: (id: string | null) => void,
    view: (state: AuthView) => void, notice = 'Прогресс сохраняется в этом браузере. Вход пока недоступен.',
    checkGoogle: () => Promise<ProviderState> = async () => 'enabled') {
    this.client = client; this.identity = identity; this.view = view; this.notice = notice; this.checkGoogle = checkGoogle;
  }
  private emit(text: string) { if (!this.disposed) this.view({ diagnostic: this.diagnostic, userId: this.userId, busy: this.busy, text, canSignOut: !!this.userId || this.blocked }); }
  private apply(id: string | null) {
    if (this.disposed) return;
    this.userId = id; this.busy = false; this.identity(id);
    this.emit(id ? 'Вход выполнен · статус сохранения указан у каждого занятия' : 'Прогресс сохраняется в этом браузере');
  }
  start(href?: string, replace?: (url: string) => void): Promise<void> {
    return this.started ??= this.initialize(href, replace);
  }
  private async initialize(href?: string, replace?: (url: string) => void) {
    if (!this.client) { this.emit(this.notice); return; }
    this.busy = true; this.emit('Проверяем вход…');
    this.subscription = this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || this.disposed || this.blocked || (this.signingOut && event !== 'SIGNED_OUT')) return;
      if (['TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) && session?.user.id !== this.userId) return;
      this.revision++; this.apply(session?.user.id ?? null);
    }).data.subscription;
    const revision = this.revision;
    try {
      const url = new URL(href!);
      const code = url.searchParams.get('code');
      const denied = url.searchParams.has('error') || new URLSearchParams(url.hash.slice(1)).has('error');
      if (code || denied) {
        for (const key of ['code', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
        url.hash = ''; replace!(url.toString()); // consume before awaiting; reload cannot replay the code
      }
      if (denied) throw Error('oauth');
      const result = code ? await this.client.auth.exchangeCodeForSession(code) : await this.client.auth.getSession();
      if (result.error) throw result.error;
      if (revision === this.revision) this.apply(result.data.session?.user.id ?? null);
    } catch (error) {
      if (revision !== this.revision || this.disposed) return;
      this.diagnostic = authFailure(error, 'callback');
      this.apply(null); this.emit('Не удалось восстановить вход. Продолжай гостем или войди заново.');
    }
  }
  async signIn(origin: string, beforeRedirect: () => void) {
    if (!this.client || this.busy || this.blocked || this.disposed) return;
    this.busy = true; const revision = ++this.revision; this.emit('Проверяем доступность входа Google…'); beforeRedirect();
    try {
      const provider = await this.checkGoogle();
      if (revision !== this.revision || this.disposed || this.userId) return;
      if (provider !== 'enabled') {
        this.diagnostic = provider === 'disabled' ? 'provider' : 'network'; this.busy = false;
        this.emit(provider === 'disabled'
          ? 'Вход через Google пока не включён на стороне сервиса. Прогресс сохраняется в этом браузере. Можно заниматься и повторить вход позже.'
          : 'Не удалось проверить доступность входа. Проверь соединение и повтори. Прогресс сохраняется в этом браузере.');
        return;
      }
      this.diagnostic = 'none'; this.emit('Открываем Google…');
      const { error } = await this.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: new URL('/', origin).href } });
      if (error) throw error;
    } catch (error) {
      if (revision !== this.revision || this.disposed) return;
      this.diagnostic = authFailure(error, 'provider');
      this.busy = false; this.emit('Не удалось открыть вход Google. Можно продолжить локально и повторить вход.');
    }
  }
  async signOut() {
    if (!this.client || this.signingOut || this.disposed) return;
    this.signingOut = true; this.blocked = false; ++this.revision;
    this.apply(null); this.busy = true; this.emit('Выходим…');
    try {
      const { error } = await this.client.auth.signOut({ scope: 'local' });
      if (error) throw Error('signout');
      this.apply(null);
    } catch {
      this.blocked = true; this.busy = false;
      this.emit('Выход не подтверждён. Прежний профиль скрыт; повтори выход.');
    } finally { this.signingOut = false; }
  }
  dispose() { this.disposed = true; this.revision++; this.subscription?.unsubscribe(); }
}
