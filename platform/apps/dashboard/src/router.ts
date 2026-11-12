// The hash route as Preact state (`model/route.ts` parses it).
import { useEffect, useState } from 'preact/hooks';

import { parseRoute, type Route } from './model/route.js';

export {
  adminProjectHref,
  adminUserHref,
  evaluationHref,
  href,
  intentHref,
  parseRoute,
  planHref,
  type Route,
} from './model/route.js';

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
