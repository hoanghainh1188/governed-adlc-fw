// The dashboard (task U01, design/ADR-M54): sign-in, then the screens of the route. Read only.
// U05 (ADR-M73 §2.2): at start it asks whether GitHub sign-in is on and whether this browser is
// signed in with GitHub already (its session cookie), and shows what the API's callback said.
// U06 (ADR-M73 §2.3, §2.4): with a GitHub session it reads the session's CSRF token and whether
// actions are on; then the person's passkeys have a screen.
import type { Me } from '@sdlc/api-schemas';
import { useEffect, useState } from 'preact/hooks';

import { ApiError } from './api/client.js';
import { readAuthConfig, readMeWithCookie, readWebSession } from './api/reads.js';
import { endSession } from './api/writes.js';
import { Txt } from './components/common.js';
import { Lazy } from './components/Lazy.js';
import { t } from './i18n.js';
import { href, useRoute, type Route } from './router.js';
import { session } from './session.js';
import { Audit } from './views/Audit.js';
import { Escalations } from './views/Escalations.js';
import { IntentDetail } from './views/IntentDetail.js';
import { IntentsBoard } from './views/IntentsBoard.js';
import { EvalPlan } from './views/EvalPlan.js';
import { EvalPlanEdit, EvalPlanNew } from './views/EvalPlanForm.js';
import { Evaluation } from './views/Evaluation.js';
import { Evaluations } from './views/Evaluations.js';
import { Numbers } from './views/Numbers.js';
import { Passkeys } from './views/Passkeys.js';
import { SignIn, type SignInNotice } from './views/SignIn.js';

/**
 * The `?signin=` parameter the API's callback adds on a refusal, read once and removed from the
 * address bar so a reload does not show it again.
 */
function takeSignInNotice(): SignInNotice | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get('signin');
  if (value === null) return null;
  params.delete('signin');
  const search = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`,
  );
  return value === 'refused' || value === 'unavailable' ? value : null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [starting, setStarting] = useState(true);
  const [github, setGithub] = useState(false);
  const [notice] = useState(takeSignInNotice);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const route = useRoute();

  // The API ended the session (401), or the person signed out: back to sign-in.
  useEffect(
    () =>
      session.subscribe(() => {
        if (session.signedIn()) return;
        setMe(null);
        setSignOutFailed(false);
      }),
    [],
  );
  useEffect(() => {
    document.title = me ? t('dashboard.title.signed_in') : t('dashboard.title.signed_out');
  }, [me]);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const config = await readAuthConfig({ signal: abort.signal });
        setGithub(config.github);
        if (config.github) {
          const found = await readMeWithCookie({ signal: abort.signal });
          session.signInWithCookie();
          const web = await readWebSession({ signal: abort.signal });
          session.setWebSession({ csrfToken: web.csrf_token, actions: web.actions });
          setMe(found);
        }
      } catch {
        // No GitHub session (401) or no answer: the sign-in page.
      } finally {
        if (!abort.signal.aborted) setStarting(false);
      }
    })();
    return () => abort.abort();
  }, []);

  const signOut = async (scope: 'this' | 'everywhere') => {
    setSignOutFailed(false);
    if (session.cookie()) {
      try {
        await endSession(scope);
      } catch (error) {
        // 401: the session had ended already (the client signed this tab out). Otherwise the
        // session stays at the API: say so, and keep the person signed in here.
        if (!(error instanceof ApiError && error.status === 401)) setSignOutFailed(true);
        return;
      }
    }
    session.signOut();
  };

  if (starting) {
    return (
      <main id="main" class="signin" aria-busy="true">
        <p class="hint">{t('dashboard.signin.starting')}</p>
      </main>
    );
  }
  if (me === null || !session.signedIn()) {
    return <SignIn onSignedIn={setMe} github={github} notice={notice} />;
  }
  return (
    <>
      <a class="skip" href="#main">
        {t('dashboard.nav.skip')}
      </a>
      <header class="masthead">
        <div class="masthead-inner">
          <a class="brand" href={href('intents')}>
            <span class="brand-mark" aria-hidden="true" />
            {t('dashboard.brand')}
          </a>
          <nav aria-label={t('dashboard.nav.label')}>
            <ul class="nav">
              <NavItem route={route} name="intents" label={t('dashboard.nav.intents')} />
              <NavItem route={route} name="escalations" label={t('dashboard.nav.escalations')} />
              <NavItem route={route} name="numbers" label={t('dashboard.nav.numbers')} />
              <NavItem route={route} name="evaluations" label={t('dashboard.nav.evaluations')} />
              {me.tenant_admin === true && (
                <NavItem route={route} name="audit" label={t('dashboard.nav.audit')} />
              )}
              {mayAdminister(me) && (
                <NavItem route={route} name="admin" label={t('dashboard.nav.admin')} />
              )}
              {session.actions() && (
                <NavItem route={route} name="passkeys" label={t('dashboard.nav.passkeys')} />
              )}
            </ul>
          </nav>
          <div class="who">
            <span class="who-name">
              <Txt value={me.user.display_name} />
            </span>
            <span class="read-only-tag">{t('dashboard.read_only')}</span>
            <button type="button" class="button button-quiet" onClick={() => void signOut('this')}>
              {t('dashboard.signout')}
            </button>
            {session.cookie() && (
              <button
                type="button"
                class="button button-quiet"
                onClick={() => void signOut('everywhere')}
              >
                {t('dashboard.signout_everywhere')}
              </button>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {signOutFailed && (
          <p class="notice notice-error" role="alert">
            {t('dashboard.signout_failed')}
          </p>
        )}
        <Screen route={route} me={me} />
      </main>
    </>
  );
}

function NavItem({
  route,
  name,
  label,
}: {
  readonly route: Route;
  readonly name: Route['name'];
  readonly label: string;
}) {
  const active =
    route.name === name ||
    (name === 'intents' && route.name === 'intent') ||
    (name === 'evaluations' && route.name.startsWith('eval')) ||
    (name === 'admin' && route.name.startsWith('admin'));
  return (
    <li>
      <a href={href(name)} aria-current={active ? 'page' : undefined}>
        {label}
      </a>
    </li>
  );
}

function Screen({ route, me }: { readonly route: Route; readonly me: Me }) {
  switch (route.name) {
    case 'intent':
      return <IntentDetail code={route.code} />;
    case 'escalations':
      return <Escalations />;
    case 'numbers':
      return <Numbers me={me} query={route.query} />;
    case 'evaluations':
      return <Evaluations me={me} query={route.query} />;
    case 'eval-plan':
      return <EvalPlan id={route.id} />;
    case 'eval-plan-new':
      return <EvalPlanNew query={route.query} />;
    case 'eval-plan-edit':
      return <EvalPlanEdit id={route.id} />;
    case 'evaluation':
      return <Evaluation code={route.code} />;
    case 'passkeys':
      return session.actions() ? <Passkeys /> : <IntentsBoard me={me} query={route.query} />;
    case 'audit':
      return me.tenant_admin === true ? <Audit /> : <IntentsBoard me={me} query={route.query} />;
    // U09: administration; the API decides what each person may read and change.
    case 'admin':
    case 'admin-project':
    case 'admin-config':
    case 'admin-user':
      return mayAdminister(me) ? (
        <Lazy load={loadAdmin}>
          {(screens) => <AdminScreen route={route} me={me} screens={screens} />}
        </Lazy>
      ) : (
        <IntentsBoard me={me} query={route.query} />
      );
    default:
      return <IntentsBoard me={me} query={route.query} />;
  }
}

/** U09: a tenant admin, or a person with the project role `admin` somewhere. */
function mayAdminister(me: Me): boolean {
  return me.tenant_admin === true || me.roles.some((r) => r.role === 'admin');
}

/** U09 (QUESTIONS #686): the administration screens are a chunk of their own. */
const loadAdmin = () => import('./views/admin-screens.js');
type AdminScreens = Awaited<ReturnType<typeof loadAdmin>>;

function AdminScreen({
  route,
  me,
  screens,
}: {
  readonly route: Route;
  readonly me: Me;
  readonly screens: AdminScreens;
}) {
  switch (route.name) {
    case 'admin-project':
      return <screens.AdminProject slug={route.slug} me={me} />;
    case 'admin-config':
      return <screens.AdminConfig slug={route.slug} />;
    case 'admin-user':
      return <screens.AdminUser id={route.id} />;
    default:
      return <screens.Admin me={me} />;
  }
}
