'use strict';

// Suite identity (Home Base Feature-10). SOVEREIGN_AUTH_MODE picks how Family Pulse knows who is asking: 'local' is
// its own passphrases and sessions, 'tailnet' the household member nginx names. Home Base writes the mode when it
// switches the app over; an install from before that has none, which means local.
//
// In tailnet mode this runs before anything else reads the request. Everything after it sees the same req.member
// as in local mode, but its role is the directory's, checked on every request. The role on the family_members row
// never decides what someone may do.
const { createAssurance, createIdentity, createRequestGuard, createSnapshotReader, guardExpress } = require('sovereign-auth');
const logger = require('./logger');

const APP_ID = 'family-pulse';

// SOVEREIGN_HOMEBASE_UID: the owner Home Base gives its directory snapshot. Never root.
function homeBaseUid(value) {
  const text = String(value ?? '').trim();
  const uid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
  if (!(uid < 4294967295)) throw new Error(`SOVEREIGN_HOMEBASE_UID must be the Home Base user's uid, not '${text}'`);
  return uid;
}

// The origin every write must come from in tailnet mode: the address Home Base publishes the app at.
function publicOrigin(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error(`tailnet mode needs APP_PUBLIC_URL, the app's https address, not '${value ?? ''}'`);
  return url.origin;
}

// Where the app's pages live under that address (/pulse/). Plain path segments only, so a redirect built on it stays
// on this host: '//elsewhere/' would send the browser off it.
function publicPath(value) {
  const { pathname } = new URL(String(value));
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+)?$/.test(pathname)) {
    throw new Error(`APP_PUBLIC_URL must have a plain path such as /pulse/, not '${pathname}'`);
  }
  return pathname.replace(/\/?$/, '/');
}

// Requests that need no member: Home Base's health and readiness probes, which come over the socket with no identity
// headers and no fetch metadata, and the page assets (never data).
const OPEN_PATHS = new Set(['/api/health', '/api/ready']);
const ASSET_PATH = /^\/[\w.-]+\.(?:css|js|svg|ico|png|woff2?)$/;

// The routes that take uploads. Everywhere else a write is JSON only, which keeps forms out.
const UPLOAD_ROUTE = /^\/api\/(?:import\/(?:upload|commit)|transactions\/[1-9][0-9]{0,18}\/attachments)$/;

// What a parent nobody has linked yet may use: the link page, and setup while Family Pulse has no household (setup
// refuses once one exists). Anything else sends them to the link page.
const UNLINKED_PARENT_PATHS = new Set(['/link', '/api/suite/links', '/setup', '/setup.html', '/api/bootstrap', '/api/bootstrap/household']);
const LINK_ROUTE = /^\/api\/suite\/links\/[1-9][0-9]{0,18}$/;

// Kids have no passkey (D7), so what they reach is listed here and everything else is refused. Each of these scopes
// its answer to req.member on the server (test/kids-auth.test.js).
const KID_API_ROUTES = [
  ['GET', /^\/api\/auth\/me$/],
  ['POST', /^\/api\/auth\/logout$/],
  ['GET', /^\/api\/kids\/(?:dashboard|report-card)$/],
  ['GET', /^\/api\/categories$/],
  ['GET', /^\/api\/transactions\/[1-9][0-9]{0,18}$/],
  ['PUT', /^\/api\/transactions\/[1-9][0-9]{0,18}\/category$/],
  ['GET', /^\/api\/transactions\/[1-9][0-9]{0,18}\/attachments$/],
  ['GET', /^\/api\/transaction-attachments\/[1-9][0-9]{0,18}\/download$/],
];
const KID_PAGE = /^\/kids(?:\.html|\/[^/]+)$/;

// The one API route a link opens directly: everything else under /api/ is for the app's own pages. A sibling
// hostname can navigate here with the member's identity (D20), and some of these GETs generate and log reports.
const NAVIGABLE_API = /^\/api\/transaction-attachments\/[1-9][0-9]{0,18}\/download$/;

// Express matches routes in any case and with a trailing slash. A check that refuses something has to see every
// spelling that reaches the route. The allowlists above stay exact on purpose: a spelling they don't know is refused.
const isApiPath = (path) => /^\/api(?:\/|$)/i.test(path);
const routeSpelling = (path) => path.toLowerCase().replace(/\/+$/, '');

// Passkeys (wire contract, section 8). A parent opens Family Pulse with a passkey check that lasts the policy's window
// (open-documents: 30 days on that device); kids have none (D7) and never meet one. These changes also need a check in
// the last five minutes: who is linked to which bank, which accounts a kid sees, where alerts about the household's
// money go, and which household account is which person here. Matched on the route's spelling, so every spelling
// Express routes is covered, and by prefix, so a route added later under them is covered too. Finishing a bank link
// (exchange, complete-*) needs only the session: it carries what Plaid gave for a link a recent check started, and a
// bank's own sign-in can take longer than five minutes.
const OPEN_POLICY = 'open-documents';
const RECENT_ROUTES = [
  ['POST', /^\/api\/link\/(?!(?:exchange|complete-account-selection|complete-liability-upgrade)$)/, 'link-account'],
  ['DELETE', /^\/api\/items\//, 'link-account'],
  ['PUT', /^\/api\/auth\/account-members$/, 'export-data'],
  ['PUT', /^\/api\/notification-channels\/[^/]+\/brrr$/, 'export-data'],
  ['PUT', /^\/api\/suite\/links\//, 'change-role'],
];
function recentPolicy(method, route) {
  return RECENT_ROUTES.find(([m, pattern]) => m === method && pattern.test(route))?.[2] ?? null;
}

// Local sign-in has no meaning in tailnet mode, and its saved passphrases wait untouched for a return to local mode.
const LOCAL_AUTH_ROUTES = new Set(['POST /api/auth/login', 'PUT /api/auth/passphrase']);

const REFUSALS = {
  directory: {
    status: 503,
    title: 'Family Pulse can\'t check who you are right now',
    text: 'It couldn\'t read the household directory from Home Base. Try again in a minute, and if this keeps happening, tell whoever runs Home Base.',
  },
  not_member: {
    status: 403,
    title: 'Family Pulse doesn\'t know you yet',
    text: 'Ask whoever runs Home Base to give you access to Family Pulse.',
  },
  not_linked: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account isn\'t linked to anyone in Family Pulse yet. Ask a parent to link you.',
  },
  stale_link: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account is now a kid\'s, but it\'s still linked to a parent in Family Pulse. Ask a parent to link you again.',
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function askPage({ title, text }, name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Family Pulse</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f4f5f7; color: #1f2933; }
  main { max-width: 28rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #52606d; }
  #passkey-status:not(:empty) { margin-top: 1rem; }
  button { margin-top: 1rem; min-height: 44px; padding: 0 1.25rem; border: 0; border-radius: 8px; font: inherit; color: #fff; background: #10b981; cursor: pointer; }
  @media (prefers-color-scheme: dark) { body { background: #14171c; color: #e4e7eb; } p { color: #9aa5b1; } }
</style>
</head>
<body><main><h1>${escapeHtml(name ? `${title}, ${name}` : title)}</h1><p>${escapeHtml(text)}</p></main></body>
</html>
`;
}

// What a parent sees when Family Pulse needs a passkey check before it opens: passkey.js asks Home Base's helper on this
// hostname for the check, then reloads.
function passkeyPage(stepUp, name, basePath) {
  const page = askPage({
    title: 'Check with your passkey',
    text: 'Parents open Family Pulse with a passkey, about once a month on each device.',
  }, name);
  return page
    .replace('<main>', `<main id="passkey-check" data-step-up="${escapeHtml(JSON.stringify(stepUp))}">`)
    .replace('</p></main>', `</p><p id="passkey-status" role="status"></p><button id="passkey-retry" type="button" hidden>Use passkey</button></main>\n<script src="${escapeHtml(basePath)}passkey.js"></script>`);
}

function refuse(req, res, code, member) {
  const refusal = REFUSALS[code];
  res.status(refusal.status).set('Cache-Control', 'no-store');
  if (isApiPath(req.path)) return res.json({ error: refusal.title, code });
  return res.type('html').send(askPage(refusal, member?.name));
}

// createSuiteIdentity(env) checks the configuration once, at startup: an unknown mode, or tailnet mode off the app's
// socket or without Home Base's uid and the public address, refuses to start. findLinked(memberId) returns the
// family_members row a parent linked to that directory member, or null.
function createSuiteIdentity(env = process.env, { reader, findLinked } = {}) {
  const mode = env.SOVEREIGN_AUTH_MODE === undefined ? 'local' : env.SOVEREIGN_AUTH_MODE;
  const tailnet = String(mode).trim() === 'tailnet';
  const snapshotReader = tailnet ? reader || createSnapshotReader({ homeBaseUid: homeBaseUid(env.SOVEREIGN_HOMEBASE_UID) }) : null;
  const identity = createIdentity({ appId: APP_ID, mode, listen: env.SOVEREIGN_LISTEN, reader: snapshotReader });
  if (tailnet && typeof findLinked !== 'function') throw new Error('tailnet mode needs a way to find linked members');
  const passThrough = (_req, _res, next) => next();
  if (!tailnet) return { mode: identity.mode, tailnet: false, identity, guard: passThrough, requireMember: passThrough, directory: () => null };

  // A sensitive app's own hostname: resource isolation and the write check (wire contract, section 4). Both read only
  // the method and headers, so they run before anything reads the body.
  const origin = publicOrigin(env.APP_PUBLIC_URL);
  const basePath = publicPath(env.APP_PUBLIC_URL);
  const assurance = createAssurance({
    appId: APP_ID,
    hostname: new URL(origin).hostname,
    identity,
    log: (line) => logger.info(line),
  });
  const writes = guardExpress(createRequestGuard({ origin }), { mode: 'enforce' });
  const uploads = guardExpress(createRequestGuard({ origin, contentTypes: ['application/json', 'multipart/form-data'] }), { mode: 'enforce' });
  function guard(req, res, next) {
    if (OPEN_PATHS.has(req.path)) return next();
    return (UPLOAD_ROUTE.test(req.path) ? uploads : writes)(req, res, next);
  }

  // The household members with access to Family Pulse, as the directory says now, or null without a snapshot.
  function directory() {
    const state = snapshotReader.current();
    if (!state?.ok) return null;
    return state.snapshot.members
      .filter((member) => member.status === 'active' && member.apps.includes(APP_ID) && member.login !== 'tagged-devices')
      .map(({ memberId, name, role }) => ({ memberId, name, role }));
  }

  function kidMayUse(req) {
    if (isApiPath(req.path)) return KID_API_ROUTES.some(([method, route]) => method === req.method && route.test(req.path));
    return KID_PAGE.test(req.path);
  }

  // Runs the passkey checks a parent's request needs: true once it has answered with a refusal.
  async function passkeyRefused(req, res, member, route, isApi) {
    const request = { method: req.method, url: req.originalUrl, headers: req.headers };
    for (const policy of [OPEN_POLICY, recentPolicy(req.method, route)]) {
      if (!policy) continue;
      const decision = await assurance.check(policy, request);
      if (decision.allowed) continue;
      res.status(decision.status).set('Cache-Control', 'no-store');
      if (!isApi && ['GET', 'HEAD'].includes(req.method) && decision.status === 401) {
        res.type('html').send(passkeyPage(decision.body, member.name, basePath));
      } else {
        res.json(decision.body);
      }
      return true;
    }
    return false;
  }

  async function requireMember(req, res, next) {
    if (OPEN_PATHS.has(req.path) || (['GET', 'HEAD'].includes(req.method) && ASSET_PATH.test(req.path))) return next();
    const isApi = isApiPath(req.path);
    const route = routeSpelling(req.path);
    if (isApi && req.headers['sec-fetch-mode'] === 'navigate' && !NAVIGABLE_API.test(req.path)) {
      return res.status(403).set('Cache-Control', 'no-store').json({ error: 'This address is only for Family Pulse\'s own pages.', code: 'not_a_page' });
    }
    const { member, reason } = identity.identify(req.headers);
    if (!member) return refuse(req, res, reason === 'no_snapshot' ? 'directory' : 'not_member');
    let row;
    try {
      row = await findLinked(member.memberId);
    } catch (err) {
      return next(err);
    }
    const isParent = member.role === 'parent';
    if (!row && !isParent) return refuse(req, res, 'not_linked', member);
    // A kid's pages show the data of the member they are linked to, so a kid's account opens only a kid's row. The
    // directory can change a role at any time after the link was made, so this is checked on every request.
    if (row && !isParent && row.role !== 'kid') return refuse(req, res, 'stale_link', member);
    if (!row && !UNLINKED_PARENT_PATHS.has(req.path) && !LINK_ROUTE.test(req.path)) {
      if (req.method === 'GET' && !isApi) return res.redirect(303, `${basePath}link`);
      return refuse(req, res, 'not_linked', member);
    }
    if (LOCAL_AUTH_ROUTES.has(`${req.method} ${route}`)) {
      return res.status(409).json({ error: 'Family Pulse signs in through your household account here.', code: 'tailnet_mode' });
    }
    if (isParent) {
      try {
        if (await passkeyRefused(req, res, member, route, isApi)) return undefined;
      } catch (err) {
        return next(err);
      }
    }
    if (!isParent && !kidMayUse(req)) {
      if (isApi) return res.status(403).set('Cache-Control', 'no-store').json({ error: 'Parent access required', code: 'parent_only' });
      return res.redirect(303, `${basePath}kids.html`);
    }
    if (route === '/login.html') return res.redirect(303, basePath);
    req.suiteMember = member;
    if (row) req.member = { id: row.id, name: row.name, role: isParent ? 'parent' : 'kid', avatar_emoji: row.avatar_emoji };
    return next();
  }

  return { mode: identity.mode, tailnet: true, identity, guard, requireMember, directory };
}

module.exports = { APP_ID, createSuiteIdentity, homeBaseUid, publicOrigin, publicPath };
