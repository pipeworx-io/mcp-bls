interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * BLS MCP — Bureau of Labor Statistics public data API (v2)
 *
 * No auth needed for basic access. Optional _apiKey (BLS registration key) for higher rate limits.
 * API: https://api.bls.gov/publicAPI/v2/timeseries/data/
 *
 * Tools:
 * - bls_get_series: get time series data for one or more BLS series
 * - bls_search: look up common series IDs by keyword (curated reference)
 * - bls_latest: get the most recent data point for a series
 * - bls_popular_series: list popular housing & employment series with descriptions
 */

import { parseXlsx } from './xlsx.js';
import type { LausAreaRow } from './laus-area-data.js';

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'BLS');
}


const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

// ── Curated series catalog ──────────────────────────────────────────────

interface SeriesEntry {
  id: string;
  title: string;
  category: string;
  description: string;
}

const CURATED_SERIES: SeriesEntry[] = [
  // Employment
  { id: 'CES0000000001', title: 'Total Nonfarm Employment', category: 'employment', description: 'Total nonfarm payroll employment (seasonally adjusted), the headline jobs number from the monthly Employment Situation report.' },
  { id: 'LNS14000000', title: 'Unemployment Rate', category: 'employment', description: 'Civilian unemployment rate (seasonally adjusted), percentage of labor force that is unemployed.' },
  { id: 'LNS11300000', title: 'Labor Force Participation Rate', category: 'employment', description: 'Civilian labor force participation rate (seasonally adjusted).' },
  { id: 'CES2000000001', title: 'Construction Employment', category: 'employment', description: 'Total construction sector employment (seasonally adjusted). Key indicator for housing construction activity.' },
  { id: 'CES2023610001', title: 'Residential Building Construction Employment', category: 'housing', description: 'Employment in residential building construction (NAICS 2361).' },
  { id: 'CES2023800001', title: 'Specialty Trade Contractors Employment', category: 'housing', description: 'Employment in specialty trade contractors (NAICS 238), includes plumbing, electrical, HVAC for housing.' },
  { id: 'JTS000000000000000HIR', title: 'JOLTS Total Hires', category: 'employment', description: 'Total hires from the Job Openings and Labor Turnover Survey (JOLTS).' },
  { id: 'JTS000000000000000JOL', title: 'JOLTS Job Openings', category: 'employment', description: 'Total job openings from JOLTS.' },
  { id: 'JTS000000000000000QUR', title: 'JOLTS Quits Rate', category: 'employment', description: 'Total quits rate from JOLTS, a measure of worker confidence.' },
  { id: 'CES0500000003', title: 'Average Hourly Earnings (Private)', category: 'wages', description: 'Average hourly earnings of all employees on private nonfarm payrolls (seasonally adjusted).' },

  // Prices / CPI
  { id: 'CUUR0000SA0', title: 'CPI-U All Items', category: 'prices', description: 'Consumer Price Index for All Urban Consumers, all items (not seasonally adjusted). The headline inflation measure.' },
  { id: 'CUUR0000SA0L1E', title: 'CPI-U All Items Less Food & Energy', category: 'prices', description: 'Core CPI excluding food and energy (not seasonally adjusted).' },
  { id: 'CUUR0000SEHA', title: 'CPI-U Rent of Primary Residence', category: 'housing', description: 'CPI for rent of primary residence (not seasonally adjusted). Key housing cost component.' },
  { id: 'CUUR0000SEHC', title: 'CPI-U Owners Equivalent Rent', category: 'housing', description: 'CPI for owners\' equivalent rent of residences (not seasonally adjusted). Largest single component of CPI.' },
  { id: 'CUUR0000SAH1', title: 'CPI-U Shelter', category: 'housing', description: 'CPI for shelter (not seasonally adjusted). Covers rent, owners\' equivalent rent, lodging.' },
  { id: 'CUUR0000SEHF01', title: 'CPI-U Electricity', category: 'housing', description: 'CPI for electricity (not seasonally adjusted). Housing utility cost.' },
  { id: 'CUUR0000SEHF02', title: 'CPI-U Piped Gas', category: 'housing', description: 'CPI for utility (piped) gas service (not seasonally adjusted).' },

  // Producer Prices
  { id: 'PCU236211236211', title: 'PPI Residential Construction', category: 'housing', description: 'Producer Price Index for new single-family residential construction (general contractors).' },
  { id: 'WPU081', title: 'PPI Lumber & Wood Products', category: 'housing', description: 'Producer Price Index for lumber and wood products. Key input cost for housing construction.' },

  // Productivity
  { id: 'PRS85006092', title: 'Nonfarm Business Labor Productivity', category: 'productivity', description: 'Output per hour of all persons in the nonfarm business sector (seasonally adjusted).' },
  { id: 'PRS85006112', title: 'Nonfarm Business Unit Labor Costs', category: 'productivity', description: 'Unit labor costs in the nonfarm business sector (seasonally adjusted).' },

  // International Trade Prices (BLS International Price Program)
  { id: 'EIUIR', title: 'Import Price Index: All Imports', category: 'trade', description: 'BLS International Price Program import price index for all goods imported into the US (not seasonally adjusted, monthly). Use to track trends in US import prices over time.' },
  { id: 'EIUXI', title: 'Export Price Index: All Exports', category: 'trade', description: 'BLS International Price Program export price index for all goods exported from the US (not seasonally adjusted, monthly). Use to track trends in US export prices over time.' },
];

// fleet #3615: the LAUS area crosswalk (~8,200 areas, 337 KiB) lives in
// ./laus-area-data.ts as a BAKED INDEX — uploaded to KV at deploy and injected
// by the gateway as args._bakedIndex — so it no longer sits in every gateway
// isolate. NEVER value-import ./laus-area-data.js here: a type-only import is
// erased; a value import puts the whole table back into the bundle.

function extractKey(args: Record<string, unknown>): string | undefined {
  const key = args._apiKey as string | undefined;
  delete args._apiKey;
  return key || undefined;
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'bls_get_series',
    description:
      'Fetch historical time series data for employment, inflation, wages, productivity, or housing. Returns dated data points with values. Provide series ID (e.g., "PAYEMS" for total nonfarm employment).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'BLS series ID (e.g., "LNS14000000" for unemployment rate). For multiple series, comma-separate them (e.g., "LNS14000000,CES0000000001").' },
        start_year: { type: 'string', description: 'Start year (e.g., "2023"). Default: current year minus 2.' },
        end_year: { type: 'string', description: 'End year (e.g., "2024"). Default: current year.' },
        _apiKey: { type: 'string', description: 'BLS registration key (optional, increases rate limits)' },
      },
      required: ['series_id'],
    },
  },
  {
    name: 'bls_search',
    description:
      'Search BLS economic data series by keyword. Returns matching series IDs and titles. Use bls_get_series with an ID to fetch historical data points.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Keyword to search for (e.g., "rent", "construction", "unemployment", "CPI", "housing")' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'bls_latest',
    description:
      'Get the most recent data point for a BLS series. Returns latest value and date. Use when you need current figures without historical context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        series_id: { type: 'string', description: 'BLS series ID (e.g., "LNS14000000")' },
        _apiKey: { type: 'string', description: 'BLS registration key (optional)' },
      },
      required: ['series_id'],
    },
  },
  {
    name: 'bls_popular_series',
    description:
      'Browse popular BLS series by category: employment, inflation, wages, housing, productivity. Returns series IDs and descriptions. Start here to explore available data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter by category: housing, employment, prices, wages, productivity (optional, returns all if omitted)' },
      },
    },
  },
  {
    name: 'bls_local_unemployment',
    description:
      'Look up the current LOCAL-AREA unemployment rate (or employment/labor force) for a US county, metro area (MSA), or city/town by NAME — e.g. "Wake County, NC", "Cary, North Carolina", "Fargo-Moorhead MSA". Resolves the place to its BLS LAUS series id (bls_get_series cannot do this; it needs a series ID, not a place name) and returns recent monthly data. Falls back to the county when a city is below the LAUS city-reporting threshold, and says so. Data is NOT seasonally adjusted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        place: { type: 'string', description: 'Place name: a county ("Wake County"), metro area ("Fargo-Moorhead MSA", "Raleigh-Cary MSA"), or city/town ("Cary"). Include "County" or "MSA"/"Metro" in the name to disambiguate the kind when it matters.' },
        state: { type: 'string', description: 'US state, 2-letter code or full name (e.g. "NC" or "North Carolina"). Optional if already included in `place` (e.g. "Cary, NC").' },
        measure: { type: 'string', description: 'One of: "rate" (unemployment rate, default), "unemployment" (level), "employment" (level), "labor_force" (level).' },
        months: { type: 'number', description: 'How many most-recent monthly observations to return. Default 12.' },
        _apiKey: { type: 'string', description: 'BLS registration key (optional, increases rate limits)' },
      },
      required: ['place'],
    },
  },
  {
    name: 'bls_occupation_projections',
    description:
      'Official US Employment Projections by occupation (SOC code): projected 10-year employment growth (number and percent), annual average job openings, current employment, median annual wage, and typical entry education, experience and training, from the Bureau of Labor Statistics, Employment Projections program. Look up an occupation by SOC code ("15-1252") or title words ("software developers"), or rank all detailed occupations by growth, openings or wage. Answers "projected growth for registered nurses", "which occupations have the most annual openings", "fastest growing jobs". Employment and openings are in thousands. Always reports the projection vintage (base and target year) of the latest release.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        soc_code: { type: 'string', description: 'SOC code, e.g. "15-1252" (detailed), "15-1200" or "15-0000" (summary/major group).' },
        query: { type: 'string', description: 'Words from the occupation title, e.g. "nurse practitioners". Matches every word.' },
        rank_by: { type: 'string', enum: ['growth_percent', 'growth_numeric', 'openings', 'wage', 'employment'], description: 'Instead of a lookup, rank detailed occupations by this measure, highest first (default listing when neither soc_code nor query is given: openings).' },
        direction: { type: 'string', enum: ['highest', 'lowest'], description: 'With rank_by or a query list: highest (default) or lowest first, e.g. fastest declining.' },
        min_employment_thousands: { type: 'number', description: 'For rankings: ignore occupations employing fewer than this many thousand workers (default 0).' },
        limit: { type: 'number', description: 'Max occupations returned (default 10, max 50).' },
      },
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'bls_get_series':
      return getSeriesData(args);
    case 'bls_search':
      return searchSeries((args.keyword ?? args.query ?? '') as string);
    case 'bls_latest':
      return getLatest(args);
    case 'bls_popular_series':
      return listPopularSeries(args.category as string | undefined);
    case 'bls_local_unemployment':
      return getLocalUnemployment(args);
    case 'bls_occupation_projections':
      return occupationProjections(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Employment Projections (Table 1.2) ──────────────────────────────────

const EP_URL = 'https://www.bls.gov/emp/ind-occ-matrix/occupation.xlsx';
const EP_UA = 'Pipeworx/1.0 (+https://pipeworx.io; contact: hello@pipeworx.io)';
const EP_SOURCE = 'U.S. Bureau of Labor Statistics, Employment Projections program (national employment matrix)';
const EP_REFRESH_MS = 12 * 60 * 60 * 1000;

interface EpOccupation {
  soc_code: string;
  title: string;
  level: 'summary' | 'detailed';
  employment_base_thousands: number | null;
  employment_projected_thousands: number | null;
  change_numeric_thousands: number | null;
  change_percent: number | null;
  annual_openings_thousands: number | null;
  percent_self_employed: number | null;
  median_annual_wage: number | null;
  typical_entry_education: string | null;
  work_experience: string | null;
  on_the_job_training: string | null;
}
interface EpTable {
  occupations: EpOccupation[];
  base_year: number | null;
  projected_year: number | null;
  data_as_of: string | null;
  title: string;
}

let epCache: { at: number; table: EpTable } | null = null;
let epInflight: Promise<EpTable> | null = null;

function epNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  return null;
}
function epText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return !t || t === '—' ? null : t;
}

async function loadEp(): Promise<EpTable> {
  const res = await pwFetch(EP_URL, { headers: { 'User-Agent': EP_UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`BLS Employment Projections returned HTTP ${res.status}`);
  const wb = await parseXlsx(new Uint8Array(await res.arrayBuffer()));
  const sheet = wb.sheets.find((sh) => /^Table 1\.2\b/.test(sh.name));
  if (!sheet) throw new Error('BLS Employment Projections workbook changed shape: no "Table 1.2" sheet');
  const title = String(sheet.rows.get(1)?.get('A') ?? '');
  const hdr = sheet.rows.get(2);
  const hd = (c: string) => String(hdr?.get(c) ?? '');
  if (!/Employment, \d{4}/.test(hd('D')) || !/openings/i.test(hd('K')) || !/Median annual wage/i.test(hd('L'))) {
    throw new Error(`BLS Employment Projections table layout changed: columns D/K/L read "${hd('D')}" / "${hd('K')}" / "${hd('L')}"`);
  }
  const base = /Employment, (\d{4})/.exec(hd('D'));
  const proj = /Employment, (\d{4})/.exec(hd('E'));
  const occupations: EpOccupation[] = [];
  for (const [rowNum, c] of [...sheet.rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowNum < 3) continue;
    const code = typeof c.get('B') === 'string' ? (c.get('B') as string).trim() : '';
    if (!/^\d\d-\d{4}$/.test(code)) continue;
    const type = String(c.get('C') ?? '');
    occupations.push({
      soc_code: code,
      title: String(c.get('A') ?? '').trim(),
      level: type === 'Line item' ? 'detailed' : 'summary',
      employment_base_thousands: epNum(c.get('D')),
      employment_projected_thousands: epNum(c.get('E')),
      change_numeric_thousands: epNum(c.get('H')),
      change_percent: epNum(c.get('I')),
      annual_openings_thousands: epNum(c.get('K')),
      percent_self_employed: epNum(c.get('J')),
      median_annual_wage: epNum(c.get('L')),
      typical_entry_education: epText(c.get('M')),
      work_experience: epText(c.get('N')),
      on_the_job_training: epText(c.get('O')),
    });
  }
  if (occupations.length < 500) {
    throw new Error(`BLS Employment Projections parsed to only ${occupations.length} occupations; expected ~1,000 — refusing to answer from a partial table`);
  }
  const lm = res.headers.get('last-modified');
  return {
    occupations,
    base_year: base ? Number(base[1]) : null,
    projected_year: proj ? Number(proj[1]) : null,
    data_as_of: lm ? new Date(lm).toISOString().slice(0, 10) : null,
    title,
  };
}

async function getEp(): Promise<EpTable> {
  if (epCache && Date.now() - epCache.at < EP_REFRESH_MS) return epCache.table;
  if (!epInflight) {
    epInflight = loadEp().then((t) => { epCache = { at: Date.now(), table: t }; return t; }).finally(() => { epInflight = null; });
  }
  return epInflight;
}

async function occupationProjections(args: Record<string, unknown>) {
  const soc = typeof args.soc_code === 'string' ? args.soc_code.trim() : '';
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const rankBy = typeof args.rank_by === 'string' ? args.rank_by : '';
  const lowest = args.direction === 'lowest';
  const minEmp = Number(args.min_employment_thousands) > 0 ? Number(args.min_employment_thousands) : 0;
  const n = Number(args.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 10;
  const t = await getEp();
  const vintage = t.base_year && t.projected_year ? `${t.base_year}-${String(t.projected_year).slice(2)}` : null;
  const envelope = {
    source: EP_SOURCE,
    projection_period: vintage,
    base_year: t.base_year,
    projected_year: t.projected_year,
    units: 'Employment and annual openings in thousands of jobs; wage in dollars (median annual, base year); growth percent over the whole projection period, not per year.',
    data_as_of: t.data_as_of,
    note: 'Latest release only. Earlier projection vintages (e.g. 2024-34) are superseded and not served.',
  };
  if (soc && !/^\d\d-\d{4}$/.test(soc)) throw new Error('soc_code must look like "15-1252" (two digits, dash, four digits)');
  const measure = (o: EpOccupation): number | null => {
    switch (rankBy || 'annual_openings') {
      case 'growth_percent': return o.change_percent;
      case 'growth_numeric': return o.change_numeric_thousands;
      case 'wage': return o.median_annual_wage;
      case 'employment': return o.employment_base_thousands;
      default: return o.annual_openings_thousands;
    }
  };
  let pool: EpOccupation[];
  if (soc) {
    pool = t.occupations.filter((o) => o.soc_code === soc);
    if (!pool.length) {
      const prefix = soc.slice(0, 2);
      return { ...envelope, found: false, reason: 'unknown_soc_code', soc_code: soc, hint: `No occupation or group has SOC code ${soc} in the national employment matrix. Codes in major group ${prefix}: ${t.occupations.filter((o) => o.soc_code.startsWith(prefix + '-')).slice(0, 8).map((o) => o.soc_code).join(', ') || 'none'}…; or search by title with query.` };
    }
  } else if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    pool = t.occupations.filter((o) => words.every((w) => o.title.toLowerCase().includes(w)));
    if (!pool.length) return { ...envelope, found: false, reason: 'no_title_match', query: q, hint: 'No occupation title contains every word. Try fewer or singular words (e.g. "nurse"), or look up by soc_code.' };
    if (rankBy) pool = pool.filter((o) => measure(o) !== null).sort((a, b) => (lowest ? 1 : -1) * ((measure(a) ?? 0) - (measure(b) ?? 0)));
  } else {
    pool = t.occupations.filter((o) => o.level === 'detailed' && (o.employment_base_thousands ?? 0) >= minEmp && measure(o) !== null)
      .sort((a, b) => (lowest ? 1 : -1) * ((measure(a) ?? 0) - (measure(b) ?? 0)));
  }
  return {
    ...envelope,
    found: true,
    ...(soc ? { soc_code: soc } : {}),
    ...(q ? { query: q } : {}),
    ...(!soc && !q ? { ranked_by: rankBy || 'openings', direction: lowest ? 'lowest' : 'highest', min_employment_thousands: minEmp } : {}),
    total_matches: pool.length,
    truncated: pool.length > limit,
    occupations: pool.slice(0, limit),
  };
}

// ── Tool implementations ────────────────────────────────────────────────

type BlsSeriesData = {
  seriesID: string;
  data: {
    year: string;
    period: string;
    periodName: string;
    value: string;
    latest?: string;
    footnotes?: { code: string; text: string }[];
  }[];
};

type BlsApiResponse = {
  status: string;
  responseTime: number;
  message: string[];
  Results: {
    series: BlsSeriesData[];
  };
};

async function blsFetch(
  seriesIds: string[],
  opts: { startYear?: string; endYear?: string; latest?: boolean; registrationkey?: string },
): Promise<BlsApiResponse> {
  const currentYear = new Date().getFullYear();
  const body: Record<string, unknown> = { seriesid: seriesIds };
  // BLS rejects latest=true combined with a year range ("You can only request
  // latest data OR with start/end year"), so send one or the other.
  if (opts.latest) {
    body.latest = true;
  } else {
    body.startyear = opts.startYear ?? String(currentYear - 2);
    body.endyear = opts.endYear ?? String(currentYear);
  }
  if (opts.registrationkey) body.registrationkey = opts.registrationkey;

  // BLS enforces a per-SECOND cap on top of the daily one, and the whole fleet
  // shares a single registration key — so two calls fired back to back 429 with
  // "Requests Per Second Limit Exceeded" even when the daily quota is untouched.
  // That is not a caller error and it is not a dead key: it clears on its own in
  // about a second. Measured 2026-09-03: ask_pipeworx asking for Cary AND Wake
  // County made two blsFetch calls in the same turn and the whole answer failed,
  // while the same two calls spaced 6s apart succeeded 4/4. Retry the per-second
  // throttle in place (mirrors the adsb 429 pattern, fleet #685) and let the
  // daily-limit case fall through — blsNotProcessed classifies that one as
  // rate_limited with the BYO-key hint, which is the right answer for a quota.
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await pwFetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }

  if (!res || !res.ok) {
    const text = res ? await res.text() : 'no response';
    const status = res ? res.status : 0;
    throw new Error(`BLS API error (${status}): ${text}`);
  }

  return (await res.json()) as BlsApiResponse;
}

// BLS signals empty/failure via status + a message array, not HTTP codes or
// empty payloads alone — so a raw REQUEST_SUCCEEDED + [] is indistinguishable
// from "bad series id" or "we exhausted the shared key's daily quota". These
// helpers classify into machine-readable statuses agents can branch on.
function blsNotProcessed(data: BlsApiResponse): { status: string; message: string; hint: string } | null {
  const noResults = !data.Results || !Array.isArray(data.Results.series);
  if (data.status !== 'REQUEST_NOT_PROCESSED' && !noResults) return null;
  const message = (data.message ?? []).join('; ') || 'BLS returned no results.';
  const throttled = /threshold|daily|limit|exceeded/i.test(message);
  return {
    status: throttled
      ? 'rate_limited'
      : data.status === 'REQUEST_NOT_PROCESSED'
        ? 'request_not_processed'
        : 'no_results',
    message,
    hint: throttled
      ? 'The shared BLS key hit its daily query limit. Register a free key at https://data.bls.gov/registrationEngine/ and pass it via _apiKey for a much higher quota.'
      : 'Check the series IDs and date range, then retry.',
  };
}

// Per-series status when a series returned no data points: distinguish a bad
// series id (not_found) from a valid series with no observations (empty_result).
function seriesStatus(seriesId: string, hasData: boolean, messages: string[]): string | undefined {
  if (hasData) return undefined;
  const mine = messages.filter((m) => m.toLowerCase().includes(seriesId.toLowerCase()));
  const text = (mine.length ? mine : messages).join(' ').toLowerCase();
  return /does not exist|invalid series|not a valid/.test(text) ? 'not_found' : 'empty_result';
}

function periodToDate(year: string, period: string): string | undefined {
  if (period.startsWith('M')) {
    const monthNum = parseInt(period.slice(1), 10);
    if (monthNum >= 1 && monthNum <= 12) return `${year}-${String(monthNum).padStart(2, '0')}-01`;
  }
  if (period.startsWith('Q')) {
    const quarter = parseInt(period.slice(1), 10);
    if (quarter >= 1 && quarter <= 4) return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  }
  return undefined;
}

async function getSeriesData(args: Record<string, unknown>) {
  const key = extractKey(args);
  const rawIds = args.series_id as string;
  const seriesIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);

  if (seriesIds.length === 0) throw new Error('At least one series_id is required');
  if (seriesIds.length > 50) throw new Error('Maximum 50 series per request');

  const data = await blsFetch(seriesIds, {
    startYear: args.start_year as string | undefined,
    endYear: args.end_year as string | undefined,
    registrationkey: key,
  });

  const notProcessed = blsNotProcessed(data);
  if (notProcessed) return notProcessed;

  const messages = data.message ?? [];
  return {
    status: 'ok',
    series: data.Results.series.map((s) => {
      const points = s.data.map((d) => {
        const date = periodToDate(d.year, d.period);
        return {
          year: d.year,
          period: d.period,
          period_name: d.periodName,
          ...(date ? { date } : {}),
          value: d.value,
          latest: d.latest === 'true',
        };
      });
      const st = seriesStatus(s.seriesID, points.length > 0, messages);
      // BLS returns each series NEWEST-first and we pass that through untouched.
      // Saying so in the payload is the difference between a caller charting a
      // trend and charting it backwards — the order was only ever implied by
      // reading the dates (fleet #718). `count` equals what's here: BLS returns
      // every point in the requested year range, so there is nothing truncated.
      // Flag empty/not-found per series so the agent doesn't read "" as a real
      // zero or as "this metro has no data".
      return {
        series_id: s.seriesID,
        count: points.length,
        observation_order: 'newest_first',
        data: points,
        ...(st ? { status: st } : {}),
      };
    }),
    ...(messages.length ? { messages } : {}),
  };
}

// ── LAUS local-area resolution (bls_local_unemployment) ────────────────
//
// Resolves a place name (county / MSA / city-town) to a BLS LAUS series id.
// Source of the area crosswalk: https://download.bls.gov/pub/time.series/la/la.area
// (download.bls.gov blocks non-browser UAs with an Akamai "Access Denied"
// page — even robots.txt 403s from a plain curl. Snapshot fetched 2026-09-03
// and bundled below rather than fetched live at request time.)
//
// Series id grammar (verified live against api.bls.gov 2026-09-03):
//   "LAU" + area_code(15 chars, already includes its own 2-letter type
//   prefix: ST/CN/MT/MC/CA/DV/CT/CS) + measure_code(2 digits)
//   e.g. LAU + CN3718300000000 + 03 = LAUCN371830000000003 (Wake County, NC
//   unemployment rate) — this matches the worked example BLS publishes.
// LAUS local-area data is NOT seasonally adjusted (NSA).

type LaKind =
  | 'state' | 'county' | 'msa' | 'micropolitan_statistical_area'
  | 'combined_statistical_area' | 'metropolitan_division' | 'city'
  | 'county_subdivision' | 'part_county' | 'other';

const LA_PREFIX_KIND: Record<string, LaKind> = {
  ST: 'state', CN: 'county', MT: 'msa', MC: 'micropolitan_statistical_area',
  CA: 'combined_statistical_area', DV: 'metropolitan_division', CT: 'city',
  CS: 'county_subdivision', PT: 'part_county',
};

const LA_KIND_BONUS: Partial<Record<LaKind, number>> = {
  county: 30, city: 30, county_subdivision: 25, state: 30,
  msa: 30, micropolitan_statistical_area: 20, combined_statistical_area: 12, metropolitan_division: 15,
};

const STATE_LIST: [string, string][] = [
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'], ['california', 'CA'],
  ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'], ['district of columbia', 'DC'],
  ['florida', 'FL'], ['georgia', 'GA'], ['hawaii', 'HI'], ['idaho', 'ID'], ['illinois', 'IL'],
  ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'], ['kentucky', 'KY'], ['louisiana', 'LA'],
  ['maine', 'ME'], ['maryland', 'MD'], ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'],
  ['mississippi', 'MS'], ['missouri', 'MO'], ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'],
  ['new hampshire', 'NH'], ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'], ['oregon', 'OR'],
  ['pennsylvania', 'PA'], ['rhode island', 'RI'], ['south carolina', 'SC'], ['south dakota', 'SD'],
  ['tennessee', 'TN'], ['texas', 'TX'], ['utah', 'UT'], ['vermont', 'VT'], ['virginia', 'VA'],
  ['washington', 'WA'], ['west virginia', 'WV'], ['wisconsin', 'WI'], ['wyoming', 'WY'],
  ['puerto rico', 'PR'],
];
const STATE_NAME_TO_ABBR = new Map(STATE_LIST);
const STATE_ABBR_SET = new Set(STATE_LIST.map(([, a]) => a));

function normalizeStateInput(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (t.length === 2 && STATE_ABBR_SET.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_NAME_TO_ABBR.get(t.toLowerCase());
}

function stripStateSuffix(place: string): { core: string; stateAbbr?: string } {
  const parts = place.split(',');
  if (parts.length >= 2) {
    const trailing = parts[parts.length - 1].trim();
    const abbr = normalizeStateInput(trailing);
    if (abbr) return { core: parts.slice(0, -1).join(',').trim(), stateAbbr: abbr };
  }
  return { core: place.trim(), stateAbbr: undefined };
}

const LA_STOPWORDS = new Set(['county', 'city', 'town', 'msa', 'metro', 'metropolitan', 'statistical', 'area', 'the', 'of', 'micropolitan', 'combined']);
function laTokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !LA_STOPWORDS.has(t));
}

interface LaRecord {
  code: string; // 15-char area_code, already prefixed (CN/ST/MT/...)
  name: string; // official BLS area_text, e.g. "Wake County, NC"
  kind: LaKind;
  tokens: string[];
  stateTokens: string[]; // 2-letter uppercase tokens found in `name` (state abbreviations)
}

let LA_AREA_ROWS: LausAreaRow[] | null = null;
/**
 * Adopt the baked LAUS area table from `args._bakedIndex` (once per isolate).
 * Loud when it is missing: resolving a place against an empty table would read
 * as "no LAUS area matched", a silent wrong answer.
 */
function ensureLaAreas(args: Record<string, unknown>): void {
  if (LA_AREA_ROWS) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.LAUS_AREAS;
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
    throw new Error(
      `bls: the LAUS area table is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first local-area call; this is a server-side fault, not a bad place name — retry shortly.',
    );
  }
  LA_AREA_ROWS = rows as LausAreaRow[];
}

let LA_INDEX: LaRecord[] | null = null;
function getLaIndex(): LaRecord[] {
  if (LA_INDEX) return LA_INDEX;
  if (!LA_AREA_ROWS) throw new Error('bls: LAUS area table not adopted (ensureLaAreas must run first)');
  const records: LaRecord[] = [];
  for (const [code, name] of LA_AREA_ROWS) {
    if (!code || !name) continue;
    const prefix = code.slice(0, 2);
    records.push({
      code,
      name,
      kind: LA_PREFIX_KIND[prefix] ?? 'other',
      tokens: laTokenize(name),
      stateTokens: name.match(/\b[A-Z]{2}\b/g) ?? [],
    });
  }
  LA_INDEX = records;
  return records;
}

function laKindHints(coreLower: string): LaKind[] {
  if (/\bcounty\b/.test(coreLower)) return ['county'];
  if (/\bmsa\b|\bmetro(politan)?\b/.test(coreLower)) return ['msa', 'micropolitan_statistical_area', 'combined_statistical_area', 'metropolitan_division'];
  return ['city', 'county_subdivision'];
}

function scoreLaRecord(rec: LaRecord, queryTokens: string[], coreLower: string, kindHints: LaKind[], stateAbbr: string | undefined): number {
  if (stateAbbr && !rec.stateTokens.includes(stateAbbr)) return -Infinity;
  const textLower = rec.name.toLowerCase();
  let base = 0;
  if (textLower.startsWith(coreLower)) base = 100;
  else if (textLower.includes(coreLower)) base = 70;
  else {
    const overlap = queryTokens.filter((t) => rec.tokens.includes(t)).length;
    base = queryTokens.length ? (overlap / queryTokens.length) * 50 : 0;
  }
  if (kindHints.includes(rec.kind)) base += LA_KIND_BONUS[rec.kind] ?? 15;
  return base;
}

interface LaCandidate { code: string; name: string; kind: LaKind; score: number }

function rankLaCandidates(place: string, state: string | undefined): { candidates: LaCandidate[]; stateAbbr?: string; core: string } {
  const stripped = stripStateSuffix(place);
  const stateAbbr = normalizeStateInput(state) ?? stripped.stateAbbr;
  const core = stripped.core;
  const coreLower = core.toLowerCase();
  const queryTokens = laTokenize(core);
  const kindHints = laKindHints(coreLower);
  const records = getLaIndex().filter((r) => r.kind !== 'part_county');
  const scored = records
    .map((r) => ({ code: r.code, name: r.name, kind: r.kind, score: scoreLaRecord(r, queryTokens, coreLower, kindHints, stateAbbr) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return { candidates: scored.slice(0, 8), stateAbbr, core };
}

// County fallback via the "part-county" (PT) crosswalk rows, e.g.
// "Cary town, Wake County part, NC" -> county "Wake County, NC". Used when a
// place has no direct city/town LAUS series (below the LAUS city threshold).
function fallbackCountyFor(place: string, state: string | undefined): LaCandidate | undefined {
  const stripped = stripStateSuffix(place);
  const stateAbbr = normalizeStateInput(state) ?? stripped.stateAbbr;
  const core = stripped.core;
  const coreLower = core.toLowerCase();
  const queryTokens = laTokenize(core);
  const ptRecords = getLaIndex().filter((r) => r.kind === 'part_county' && (!stateAbbr || r.stateTokens.includes(stateAbbr)));
  let best: { rec: LaRecord; score: number } | undefined;
  for (const rec of ptRecords) {
    const textLower = rec.name.toLowerCase();
    let score = 0;
    if (textLower.startsWith(coreLower)) score = 100;
    else {
      const overlap = queryTokens.filter((t) => rec.tokens.includes(t)).length;
      score = queryTokens.length ? (overlap / queryTokens.length) * 50 : 0;
    }
    if (score > 0 && (!best || score > best.score)) best = { rec, score };
  }
  if (!best) return undefined;
  // "Cary town, Wake County part, NC" -> county name "Wake County, NC"
  const m = best.rec.name.match(/,\s*(.+?)\s+part,\s*([A-Z]{2})$/);
  if (!m) return undefined;
  const countyText = `${m[1]}, ${m[2]}`;
  const countyRec = getLaIndex().find((r) => r.kind === 'county' && r.name === countyText);
  if (!countyRec) return undefined;
  return { code: countyRec.code, name: countyRec.name, kind: 'county', score: best.score };
}

const LA_MEASURE_CODE: Record<string, string> = { rate: '03', unemployment: '04', employment: '05', labor_force: '06' };
const LA_KIND_LABEL: Partial<Record<LaKind, string>> = {
  state: 'state', county: 'county', msa: 'metropolitan statistical area',
  micropolitan_statistical_area: 'micropolitan statistical area',
  combined_statistical_area: 'combined statistical area',
  metropolitan_division: 'metropolitan division', city: 'city/town', county_subdivision: 'county subdivision (New England town)',
};

async function getLocalUnemployment(args: Record<string, unknown>) {
  const key = extractKey(args);
  const place = String(args.place ?? '').trim();
  const state = args.state !== undefined ? String(args.state) : undefined;
  const measureInput = (args.measure as string | undefined)?.toLowerCase().trim();
  const measure = measureInput && measureInput in LA_MEASURE_CODE ? measureInput : 'rate';
  const months = typeof args.months === 'number' && args.months > 0 ? Math.min(Math.floor(args.months), 240) : 12;

  if (!place) throw new Error('place is required, e.g. "Cary" or "Wake County" (optionally with state)');
  ensureLaAreas(args);

  const { candidates, stateAbbr } = rankLaCandidates(place, state);

  let chosen: LaCandidate | undefined;
  let fallback: { used: boolean; from_kind?: string; reason?: string } = { used: false };

  if (candidates.length === 0) {
    // No direct city/town/county/MSA match at all — try the county fallback
    // (covers places below the LAUS city-level reporting threshold).
    const fb = fallbackCountyFor(place, state);
    if (fb) {
      chosen = fb;
      fallback = { used: true, from_kind: 'city', reason: `No direct LAUS series for "${place}" — it is likely below the LAUS city/town reporting threshold. Falling back to its county, ${fb.name}.` };
    } else {
      return {
        status: 'not_found',
        query: { place, state: state ?? null },
        message: `No LAUS area matched "${place}"${stateAbbr ? ` in ${stateAbbr}` : ''}, and no county fallback could be resolved.`,
        hint: 'Check spelling, or pass an explicit `state` (2-letter code or full name). Note LAUS only publishes city/town-level series for places above a population threshold — try the county name instead.',
      };
    }
  } else {
    const top = candidates[0];
    const second = candidates[1];
    const clear = !second || top.score - second.score >= 15;
    if (!clear) {
      return {
        status: 'ambiguous',
        query: { place, state: state ?? null },
        candidates: candidates.map((c) => ({ name: c.name, kind: c.kind, kind_label: LA_KIND_LABEL[c.kind] ?? c.kind, area_code: c.code })),
        hint: 'Multiple places matched with similar confidence. Re-call with a more specific `place` (e.g. include "County" or "MSA") and/or an explicit `state`.',
      };
    }
    chosen = top;
    // Kind-hint mismatch fallback: caller asked for a city-shaped place but
    // the only confident match is itself below city-threshold and absent —
    // handled above via the empty-candidates branch. Here, if the resolved
    // kind is a city/town, additionally record no fallback was needed.
  }

  const seriesId = `LAU${chosen!.code}${LA_MEASURE_CODE[measure]}`;
  const currentYear = new Date().getFullYear();
  const yearsBack = Math.ceil((months + 1) / 12);
  const data = await blsFetch([seriesId], {
    startYear: String(currentYear - yearsBack),
    endYear: String(currentYear),
    registrationkey: key,
  });

  const notProcessed = blsNotProcessed(data);
  if (notProcessed) {
    return {
      ...notProcessed,
      resolved_area: { kind: chosen!.kind, kind_label: LA_KIND_LABEL[chosen!.kind] ?? chosen!.kind, name: chosen!.name, area_code: chosen!.code },
      series_id: seriesId,
    };
  }

  const series = data.Results.series[0];
  const points = (series?.data ?? []).slice(0, months).map((d) => {
    const date = periodToDate(d.year, d.period);
    return {
      year: d.year, period: d.period, period_name: d.periodName,
      ...(date ? { date } : {}),
      value: d.value,
      preliminary: (d.footnotes ?? []).some((f) => f.code === 'P'),
      latest: d.latest === 'true',
    };
  });

  if (points.length === 0) {
    return {
      status: 'empty_result',
      resolved_area: { kind: chosen!.kind, kind_label: LA_KIND_LABEL[chosen!.kind] ?? chosen!.kind, name: chosen!.name, area_code: chosen!.code },
      series_id: seriesId,
      message: `Resolved to ${chosen!.name} (${seriesId}) but BLS returned no observations for the requested window.`,
      messages: data.message ?? [],
    };
  }

  return {
    status: 'ok',
    query: { place, state: state ?? null },
    resolved_area: { kind: chosen!.kind, kind_label: LA_KIND_LABEL[chosen!.kind] ?? chosen!.kind, name: chosen!.name, area_code: chosen!.code },
    fallback,
    series_id: seriesId,
    measure,
    seasonally_adjusted: false,
    note: 'LAUS local-area (sub-national) data is NOT seasonally adjusted (NSA). A "-" value means BLS suppressed that observation.',
    latest: points[0],
    observation_order: 'newest_first',
    count: points.length,
    data: points,
    ...(data.message?.length ? { messages: data.message } : {}),
  };
}

function searchSeries(keyword: string) {
  const lower = keyword.toLowerCase();
  const matches = CURATED_SERIES.filter(
    (s) =>
      s.title.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower) ||
      s.category.toLowerCase().includes(lower) ||
      s.id.toLowerCase().includes(lower),
  );

  return {
    keyword,
    total_matches: matches.length,
    series: matches.map((s) => ({
      series_id: s.id,
      title: s.title,
      category: s.category,
      description: s.description,
    })),
    note: matches.length === 0
      ? 'No matches in curated catalog. Try broader keywords or use bls_popular_series to browse all available series. You can also use any valid BLS series ID directly with bls_get_series.'
      : undefined,
  };
}

async function getLatest(args: Record<string, unknown>) {
  const key = extractKey(args);
  const seriesId = args.series_id as string;

  const data = await blsFetch([seriesId], {
    latest: true,
    registrationkey: key,
  });

  const notProcessed = blsNotProcessed(data);
  if (notProcessed) return notProcessed;

  const messages = data.message ?? [];
  const series = data.Results.series[0];
  if (!series || series.data.length === 0) {
    // Distinct, machine-readable status instead of a generic thrown error —
    // an agent must tell "no recent observation" from "bad series id".
    const st = seriesStatus(seriesId, false, messages);
    return {
      series_id: seriesId,
      status: st,
      message: messages.join('; ') || `No recent data point for ${seriesId}.`,
      hint: st === 'not_found'
        ? 'That series ID may not exist — verify with bls_search or bls_popular_series.'
        : 'The series exists but has no observation in the recent window.',
    };
  }

  const latest = series.data[0];
  const catalogEntry = CURATED_SERIES.find((s) => s.id === seriesId);

  const latestDate = periodToDate(latest.year, latest.period);
  return {
    series_id: series.seriesID,
    status: 'ok',
    title: catalogEntry?.title ?? null,
    latest: {
      year: latest.year,
      period: latest.period,
      period_name: latest.periodName,
      ...(latestDate ? { date: latestDate } : {}),
      value: latest.value,
    },
  };
}

function listPopularSeries(category?: string) {
  const filtered = category
    ? CURATED_SERIES.filter((s) => s.category.toLowerCase() === category.toLowerCase())
    : CURATED_SERIES;

  const grouped: Record<string, { series_id: string; title: string; description: string }[]> = {};
  for (const s of filtered) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push({
      series_id: s.id,
      title: s.title,
      description: s.description,
    });
  }

  return {
    filter_category: category ?? null,
    total_series: filtered.length,
    categories: grouped,
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
