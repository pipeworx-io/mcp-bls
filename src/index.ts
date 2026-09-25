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
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
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

// prettier-ignore
const LA_AREA_TSV = `A|ST0100000000000|Alabama
A|ST0200000000000|Alaska
A|ST0400000000000|Arizona
A|ST0500000000000|Arkansas
A|ST0600000000000|California
A|ST0800000000000|Colorado
A|ST0900000000000|Connecticut
A|ST1000000000000|Delaware
A|ST1100000000000|District of Columbia
A|ST1200000000000|Florida
A|ST1300000000000|Georgia
A|ST1500000000000|Hawaii
A|ST1600000000000|Idaho
A|ST1700000000000|Illinois
A|ST1800000000000|Indiana
A|ST1900000000000|Iowa
A|ST2000000000000|Kansas
A|ST2100000000000|Kentucky
A|ST2200000000000|Louisiana
A|ST2300000000000|Maine
A|ST2400000000000|Maryland
A|ST2500000000000|Massachusetts
A|ST2600000000000|Michigan
A|ST2700000000000|Minnesota
A|ST2800000000000|Mississippi
A|ST2900000000000|Missouri
A|ST3000000000000|Montana
A|ST3100000000000|Nebraska
A|ST3200000000000|Nevada
A|ST3300000000000|New Hampshire
A|ST3400000000000|New Jersey
A|ST3500000000000|New Mexico
A|ST3600000000000|New York
A|ST3700000000000|North Carolina
A|ST3800000000000|North Dakota
A|ST3900000000000|Ohio
A|ST4000000000000|Oklahoma
A|ST4100000000000|Oregon
A|ST4200000000000|Pennsylvania
A|ST4400000000000|Rhode Island
A|ST4500000000000|South Carolina
A|ST4600000000000|South Dakota
A|ST4700000000000|Tennessee
A|ST4800000000000|Texas
A|ST4900000000000|Utah
A|ST5000000000000|Vermont
A|ST5100000000000|Virginia
A|ST5300000000000|Washington
A|ST5400000000000|West Virginia
A|ST5500000000000|Wisconsin
A|ST5600000000000|Wyoming
A|ST7200000000000|Puerto Rico
B|MT0111500000000|Anniston-Oxford, AL Metropolitan Statistical Area
B|MT0112220000000|Auburn-Opelika, AL Metropolitan Statistical Area
B|MT0113820000000|Birmingham, AL Metropolitan Statistical Area
B|MT0119300000000|Daphne-Fairhope-Foley, AL Metropolitan Statistical Area
B|MT0119460000000|Decatur, AL Metropolitan Statistical Area
B|MT0120020000000|Dothan, AL Metropolitan Statistical Area
B|MT0122520000000|Florence-Muscle Shoals, AL Metropolitan Statistical Area
B|MT0123460000000|Gadsden, AL Metropolitan Statistical Area
B|MT0126620000000|Huntsville, AL Metropolitan Statistical Area
B|MT0133660000000|Mobile, AL Metropolitan Statistical Area
B|MT0133860000000|Montgomery, AL Metropolitan Statistical Area
B|MT0146220000000|Tuscaloosa, AL Metropolitan Statistical Area
B|MT0211260000000|Anchorage, AK Metropolitan Statistical Area
B|MT0221820000000|Fairbanks-College, AK Metropolitan Statistical Area
B|MT0422380000000|Flagstaff, AZ Metropolitan Statistical Area
B|MT0429420000000|Lake Havasu City-Kingman, AZ Metropolitan Statistical Area
B|MT0438060000000|Phoenix-Mesa-Chandler, AZ Metropolitan Statistical Area
B|MT0439150000000|Prescott Valley-Prescott, AZ Metropolitan Statistical Area
B|MT0443420000000|Sierra Vista-Douglas, AZ Metropolitan Statistical Area
B|MT0446060000000|Tucson, AZ Metropolitan Statistical Area
B|MT0449740000000|Yuma, AZ Metropolitan Statistical Area
B|MT0522220000000|Fayetteville-Springdale-Rogers, AR Metropolitan Statistical Area
B|MT0522900000000|Fort Smith, AR-OK Metropolitan Statistical Area
B|MT0526300000000|Hot Springs, AR Metropolitan Statistical Area
B|MT0527860000000|Jonesboro, AR Metropolitan Statistical Area
B|MT0530780000000|Little Rock-North Little Rock-Conway, AR Metropolitan Statistical Area
B|MT0612540000000|Bakersfield-Delano, CA Metropolitan Statistical Area
B|MT0617020000000|Chico, CA Metropolitan Statistical Area
B|MT0620940000000|El Centro, CA Metropolitan Statistical Area
B|MT0623420000000|Fresno, CA Metropolitan Statistical Area
B|MT0625260000000|Hanford-Corcoran, CA Metropolitan Statistical Area
B|MT0631080000000|Los Angeles-Long Beach-Anaheim, CA Metropolitan Statistical Area
B|MT0632900000000|Merced, CA Metropolitan Statistical Area
B|MT0633700000000|Modesto, CA Metropolitan Statistical Area
B|MT0634900000000|Napa, CA Metropolitan Statistical Area
B|MT0637100000000|Oxnard-Thousand Oaks-Ventura, CA Metropolitan Statistical Area
B|MT0639820000000|Redding, CA Metropolitan Statistical Area
B|MT0640140000000|Riverside-San Bernardino-Ontario, CA Metropolitan Statistical Area
B|MT0640900000000|Sacramento-Roseville-Folsom, CA Metropolitan Statistical Area
B|MT0641500000000|Salinas, CA Metropolitan Statistical Area
B|MT0641740000000|San Diego-Chula Vista-Carlsbad, CA Metropolitan Statistical Area
B|MT0641860000000|San Francisco-Oakland-Fremont, CA Metropolitan Statistical Area
B|MT0641940000000|San Jose-Sunnyvale-Santa Clara, CA Metropolitan Statistical Area
B|MT0642020000000|San Luis Obispo-Paso Robles, CA Metropolitan Statistical Area
B|MT0642100000000|Santa Cruz-Watsonville, CA Metropolitan Statistical Area
B|MT0642200000000|Santa Maria-Santa Barbara, CA Metropolitan Statistical Area
B|MT0642220000000|Santa Rosa-Petaluma, CA Metropolitan Statistical Area
B|MT0644700000000|Stockton-Lodi, CA Metropolitan Statistical Area
B|MT0646700000000|Vallejo, CA Metropolitan Statistical Area
B|MT0647300000000|Visalia, CA Metropolitan Statistical Area
B|MT0649700000000|Yuba City, CA Metropolitan Statistical Area
B|MT0814500000000|Boulder, CO Metropolitan Statistical Area
B|MT0817820000000|Colorado Springs, CO Metropolitan Statistical Area
B|MT0819740000000|Denver-Aurora-Centennial, CO Metropolitan Statistical Area
B|MT0822660000000|Fort Collins-Loveland, CO Metropolitan Statistical Area
B|MT0824300000000|Grand Junction, CO Metropolitan Statistical Area
B|MT0824540000000|Greeley, CO Metropolitan Statistical Area
B|MT0839380000000|Pueblo, CO Metropolitan Statistical Area
B|MT0914860000000|Bridgeport-Stamford-Danbury, CT Metropolitan Statistical Area
B|MT0925540000000|Hartford-West Hartford-East Hartford, CT Metropolitan Statistical Area
B|MT0935300000000|New Haven, CT Metropolitan Statistical Area
B|MT0935980000000|Norwich-New London-Willimantic, CT Metropolitan Statistical Area
B|MT0947930000000|Waterbury-Shelton, CT Metropolitan Statistical Area
B|MT1020100000000|Dover, DE Metropolitan Statistical Area
B|MT1147900000000|Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area
B|MT1215980000000|Cape Coral-Fort Myers, FL Metropolitan Statistical Area
B|MT1218880000000|Crestview-Fort Walton Beach-Destin, FL Metropolitan Statistical Area
B|MT1219660000000|Deltona-Daytona Beach-Ormond Beach, FL Metropolitan Statistical Area
B|MT1223540000000|Gainesville, FL Metropolitan Statistical Area
B|MT1226140000000|Homosassa Springs, FL Metropolitan Statistical Area
B|MT1227260000000|Jacksonville, FL Metropolitan Statistical Area
B|MT1229460000000|Lakeland-Winter Haven, FL Metropolitan Statistical Area
B|MT1233100000000|Miami-Fort Lauderdale-West Palm Beach, FL Metropolitan Statistical Area
B|MT1234940000000|Naples-Marco Island, FL Metropolitan Statistical Area
B|MT1235840000000|North Port-Bradenton-Sarasota, FL Metropolitan Statistical Area
B|MT1236100000000|Ocala, FL Metropolitan Statistical Area
B|MT1236740000000|Orlando-Kissimmee-Sanford, FL Metropolitan Statistical Area
B|MT1237340000000|Palm Bay-Melbourne-Titusville, FL Metropolitan Statistical Area
B|MT1237460000000|Panama City-Panama City Beach, FL Metropolitan Statistical Area
B|MT1237860000000|Pensacola-Ferry Pass-Brent, FL Metropolitan Statistical Area
B|MT1238940000000|Port St. Lucie, FL Metropolitan Statistical Area
B|MT1239460000000|Punta Gorda, FL Metropolitan Statistical Area
B|MT1242680000000|Sebastian-Vero Beach-West Vero Corridor, FL Metropolitan Statistical Area
B|MT1242700000000|Sebring, FL Metropolitan Statistical Area
B|MT1245220000000|Tallahassee, FL Metropolitan Statistical Area
B|MT1245300000000|Tampa-St. Petersburg-Clearwater, FL Metropolitan Statistical Area
B|MT1248680000000|Wildwood-The Villages, FL Metropolitan Statistical Area
B|MT1310500000000|Albany, GA Metropolitan Statistical Area
B|MT1312020000000|Athens-Clarke County, GA Metropolitan Statistical Area
B|MT1312060000000|Atlanta-Sandy Springs-Roswell, GA Metropolitan Statistical Area
B|MT1312260000000|Augusta-Richmond County, GA-SC Metropolitan Statistical Area
B|MT1315260000000|Brunswick-St. Simons, GA Metropolitan Statistical Area
B|MT1317980000000|Columbus, GA-AL Metropolitan Statistical Area
B|MT1319140000000|Dalton, GA Metropolitan Statistical Area
B|MT1323580000000|Gainesville, GA Metropolitan Statistical Area
B|MT1325980000000|Hinesville, GA Metropolitan Statistical Area
B|MT1331420000000|Macon-Bibb County, GA Metropolitan Statistical Area
B|MT1340660000000|Rome, GA Metropolitan Statistical Area
B|MT1342340000000|Savannah, GA Metropolitan Statistical Area
B|MT1346660000000|Valdosta, GA Metropolitan Statistical Area
B|MT1347580000000|Warner Robins, GA Metropolitan Statistical Area
B|MT1527980000000|Kahului-Wailuku, HI Metropolitan Statistical Area
B|MT1546520000000|Urban Honolulu, HI Metropolitan Statistical Area
B|MT1614260000000|Boise City, ID Metropolitan Statistical Area
B|MT1617660000000|Coeur d'Alene, ID Metropolitan Statistical Area
B|MT1626820000000|Idaho Falls, ID Metropolitan Statistical Area
B|MT1630300000000|Lewiston, ID-WA Metropolitan Statistical Area
B|MT1638540000000|Pocatello, ID Metropolitan Statistical Area
B|MT1646300000000|Twin Falls, ID Metropolitan Statistical Area
B|MT1714010000000|Bloomington, IL Metropolitan Statistical Area
B|MT1716580000000|Champaign-Urbana, IL Metropolitan Statistical Area
B|MT1716980000000|Chicago-Naperville-Elgin, IL-IN Metropolitan Statistical Area
B|MT1719340000000|Davenport-Moline-Rock Island, IA-IL Metropolitan Statistical Area
B|MT1719500000000|Decatur, IL Metropolitan Statistical Area
B|MT1728100000000|Kankakee, IL Metropolitan Statistical Area
B|MT1737900000000|Peoria, IL Metropolitan Statistical Area
B|MT1740420000000|Rockford, IL Metropolitan Statistical Area
B|MT1744100000000|Springfield, IL Metropolitan Statistical Area
B|MT1814020000000|Bloomington, IN Metropolitan Statistical Area
B|MT1818020000000|Columbus, IN Metropolitan Statistical Area
B|MT1821140000000|Elkhart-Goshen, IN Metropolitan Statistical Area
B|MT1821780000000|Evansville, IN Metropolitan Statistical Area
B|MT1823060000000|Fort Wayne, IN Metropolitan Statistical Area
B|MT1826900000000|Indianapolis-Carmel-Greenwood, IN Metropolitan Statistical Area
B|MT1829020000000|Kokomo, IN Metropolitan Statistical Area
B|MT1829200000000|Lafayette-West Lafayette, IN Metropolitan Statistical Area
B|MT1833140000000|Michigan City-La Porte, IN Metropolitan Statistical Area
B|MT1834620000000|Muncie, IN Metropolitan Statistical Area
B|MT1843780000000|South Bend-Mishawaka, IN-MI Metropolitan Statistical Area
B|MT1845460000000|Terre Haute, IN Metropolitan Statistical Area
B|MT1911180000000|Ames, IA Metropolitan Statistical Area
B|MT1916300000000|Cedar Rapids, IA Metropolitan Statistical Area
B|MT1919780000000|Des Moines-West Des Moines, IA Metropolitan Statistical Area
B|MT1920220000000|Dubuque, IA Metropolitan Statistical Area
B|MT1926980000000|Iowa City, IA Metropolitan Statistical Area
B|MT1943580000000|Sioux City, IA-NE-SD Metropolitan Statistical Area
B|MT1947940000000|Waterloo-Cedar Falls, IA Metropolitan Statistical Area
B|MT2029940000000|Lawrence, KS Metropolitan Statistical Area
B|MT2031740000000|Manhattan, KS Metropolitan Statistical Area
B|MT2045820000000|Topeka, KS Metropolitan Statistical Area
B|MT2048620000000|Wichita, KS Metropolitan Statistical Area
B|MT2114540000000|Bowling Green, KY Metropolitan Statistical Area
B|MT2121060000000|Elizabethtown, KY Metropolitan Statistical Area
B|MT2130460000000|Lexington-Fayette, KY Metropolitan Statistical Area
B|MT2131140000000|Louisville/Jefferson County, KY-IN Metropolitan Statistical Area
B|MT2136980000000|Owensboro, KY Metropolitan Statistical Area
B|MT2137140000000|Paducah, KY-IL Metropolitan Statistical Area
B|MT2210780000000|Alexandria, LA Metropolitan Statistical Area
B|MT2212940000000|Baton Rouge, LA Metropolitan Statistical Area
B|MT2225220000000|Hammond, LA Metropolitan Statistical Area
B|MT2226380000000|Houma-Bayou Cane-Thibodaux, LA Metropolitan Statistical Area
B|MT2229180000000|Lafayette, LA Metropolitan Statistical Area
B|MT2229340000000|Lake Charles, LA Metropolitan Statistical Area
B|MT2233740000000|Monroe, LA Metropolitan Statistical Area
B|MT2235380000000|New Orleans-Metairie, LA Metropolitan Statistical Area
B|MT2243340000000|Shreveport-Bossier City, LA Metropolitan Statistical Area
B|MT2243640000000|Slidell-Mandeville-Covington, LA Metropolitan Statistical Area
B|MT2312620000000|Bangor, ME Metropolitan Statistical Area
B|MT2330340000000|Lewiston-Auburn, ME Metropolitan Statistical Area
B|MT2338860000000|Portland-South Portland, ME Metropolitan Statistical Area
B|MT2412580000000|Baltimore-Columbia-Towson, MD Metropolitan Statistical Area
B|MT2425180000000|Hagerstown-Martinsburg, MD-WV Metropolitan Statistical Area
B|MT2430500000000|Lexington Park, MD Metropolitan Statistical Area
B|MT2441540000000|Salisbury, MD Metropolitan Statistical Area
B|MT2511200000000|Amherst Town-Northampton, MA Metropolitan Statistical Area
B|MT2512700000000|Barnstable Town, MA Metropolitan Statistical Area
B|MT2514460000000|Boston-Cambridge-Newton, MA-NH Metropolitan Statistical Area
B|MT2538340000000|Pittsfield, MA Metropolitan Statistical Area
B|MT2544140000000|Springfield, MA Metropolitan Statistical Area
B|MT2549340000000|Worcester, MA Metropolitan Statistical Area
B|MT2611460000000|Ann Arbor, MI Metropolitan Statistical Area
B|MT2612980000000|Battle Creek, MI Metropolitan Statistical Area
B|MT2613020000000|Bay City, MI Metropolitan Statistical Area
B|MT2619820000000|Detroit-Warren-Dearborn, MI Metropolitan Statistical Area
B|MT2622420000000|Flint, MI Metropolitan Statistical Area
B|MT2624340000000|Grand Rapids-Wyoming-Kentwood, MI Metropolitan Statistical Area
B|MT2627100000000|Jackson, MI Metropolitan Statistical Area
B|MT2628020000000|Kalamazoo-Portage, MI Metropolitan Statistical Area
B|MT2629620000000|Lansing-East Lansing, MI Metropolitan Statistical Area
B|MT2633220000000|Midland, MI Metropolitan Statistical Area
B|MT2633780000000|Monroe, MI Metropolitan Statistical Area
B|MT2634740000000|Muskegon-Norton Shores, MI Metropolitan Statistical Area
B|MT2635660000000|Niles, MI Metropolitan Statistical Area
B|MT2640980000000|Saginaw, MI Metropolitan Statistical Area
B|MT2645900000000|Traverse City, MI Metropolitan Statistical Area
B|MT2720260000000|Duluth, MN-WI Metropolitan Statistical Area
B|MT2731860000000|Mankato, MN Metropolitan Statistical Area
B|MT2733460000000|Minneapolis-St. Paul-Bloomington, MN-WI Metropolitan Statistical Area
B|MT2740340000000|Rochester, MN Metropolitan Statistical Area
B|MT2741060000000|St. Cloud, MN Metropolitan Statistical Area
B|MT2825060000000|Gulfport-Biloxi, MS Metropolitan Statistical Area
B|MT2825620000000|Hattiesburg, MS Metropolitan Statistical Area
B|MT2827140000000|Jackson, MS Metropolitan Statistical Area
B|MT2916020000000|Cape Girardeau, MO-IL Metropolitan Statistical Area
B|MT2917860000000|Columbia, MO Metropolitan Statistical Area
B|MT2927620000000|Jefferson City, MO Metropolitan Statistical Area
B|MT2927900000000|Joplin, MO-KS Metropolitan Statistical Area
B|MT2928140000000|Kansas City, MO-KS Metropolitan Statistical Area
B|MT2941140000000|St. Joseph, MO-KS Metropolitan Statistical Area
B|MT2941180000000|St. Louis, MO-IL Metropolitan Statistical Area
B|MT2944180000000|Springfield, MO Metropolitan Statistical Area
B|MT3013740000000|Billings, MT Metropolitan Statistical Area
B|MT3014580000000|Bozeman, MT Metropolitan Statistical Area
B|MT3024500000000|Great Falls, MT Metropolitan Statistical Area
B|MT3025740000000|Helena, MT Metropolitan Statistical Area
B|MT3033540000000|Missoula, MT Metropolitan Statistical Area
B|MT3124260000000|Grand Island, NE Metropolitan Statistical Area
B|MT3130700000000|Lincoln, NE Metropolitan Statistical Area
B|MT3136540000000|Omaha, NE-IA Metropolitan Statistical Area
B|MT3216180000000|Carson City, NV Metropolitan Statistical Area
B|MT3229820000000|Las Vegas-Henderson-North Las Vegas, NV Metropolitan Statistical Area
B|MT3239900000000|Reno, NV Metropolitan Statistical Area
B|MT3331700000000|Manchester-Nashua, NH Metropolitan Statistical Area
B|MT3412100000000|Atlantic City-Hammonton, NJ Metropolitan Statistical Area
B|MT3445940000000|Trenton-Princeton, NJ Metropolitan Statistical Area
B|MT3447220000000|Vineland, NJ Metropolitan Statistical Area
B|MT3510740000000|Albuquerque, NM Metropolitan Statistical Area
B|MT3522140000000|Farmington, NM Metropolitan Statistical Area
B|MT3529740000000|Las Cruces, NM Metropolitan Statistical Area
B|MT3542140000000|Santa Fe, NM Metropolitan Statistical Area
B|MT3610580000000|Albany-Schenectady-Troy, NY Metropolitan Statistical Area
B|MT3613780000000|Binghamton, NY Metropolitan Statistical Area
B|MT3615380000000|Buffalo-Cheektowaga, NY Metropolitan Statistical Area
B|MT3621300000000|Elmira, NY Metropolitan Statistical Area
B|MT3624020000000|Glens Falls, NY Metropolitan Statistical Area
B|MT3627060000000|Ithaca, NY Metropolitan Statistical Area
B|MT3628740000000|Kingston, NY Metropolitan Statistical Area
B|MT3628880000000|Kiryas Joel-Poughkeepsie-Newburgh, NY Metropolitan Statistical Area
B|MT3635620000000|New York-Newark-Jersey City, NY-NJ Metropolitan Statistical Area
B|MT3640380000000|Rochester, NY Metropolitan Statistical Area
B|MT3645060000000|Syracuse, NY Metropolitan Statistical Area
B|MT3646540000000|Utica-Rome, NY Metropolitan Statistical Area
B|MT3648060000000|Watertown-Fort Drum, NY Metropolitan Statistical Area
B|MT3711700000000|Asheville, NC Metropolitan Statistical Area
B|MT3715500000000|Burlington, NC Metropolitan Statistical Area
B|MT3716740000000|Charlotte-Concord-Gastonia, NC-SC Metropolitan Statistical Area
B|MT3720500000000|Durham-Chapel Hill, NC Metropolitan Statistical Area
B|MT3722180000000|Fayetteville, NC Metropolitan Statistical Area
B|MT3724140000000|Goldsboro, NC Metropolitan Statistical Area
B|MT3724660000000|Greensboro-High Point, NC Metropolitan Statistical Area
B|MT3724780000000|Greenville, NC Metropolitan Statistical Area
B|MT3725860000000|Hickory-Lenoir-Morganton, NC Metropolitan Statistical Area
B|MT3727340000000|Jacksonville, NC Metropolitan Statistical Area
B|MT3738240000000|Pinehurst-Southern Pines, NC Metropolitan Statistical Area
B|MT3739580000000|Raleigh-Cary, NC Metropolitan Statistical Area
B|MT3740580000000|Rocky Mount, NC Metropolitan Statistical Area
B|MT3748900000000|Wilmington, NC Metropolitan Statistical Area
B|MT3749180000000|Winston-Salem, NC Metropolitan Statistical Area
B|MT3813900000000|Bismarck, ND Metropolitan Statistical Area
B|MT3822020000000|Fargo, ND-MN Metropolitan Statistical Area
B|MT3824220000000|Grand Forks, ND-MN Metropolitan Statistical Area
B|MT3833500000000|Minot, ND Metropolitan Statistical Area
B|MT3910420000000|Akron, OH Metropolitan Statistical Area
B|MT3915940000000|Canton-Massillon, OH Metropolitan Statistical Area
B|MT3917140000000|Cincinnati, OH-KY-IN Metropolitan Statistical Area
B|MT3917410000000|Cleveland, OH Metropolitan Statistical Area
B|MT3918140000000|Columbus, OH Metropolitan Statistical Area
B|MT3919430000000|Dayton-Kettering-Beavercreek, OH Metropolitan Statistical Area
B|MT3930620000000|Lima, OH Metropolitan Statistical Area
B|MT3931900000000|Mansfield, OH Metropolitan Statistical Area
B|MT3941780000000|Sandusky, OH Metropolitan Statistical Area
B|MT3944220000000|Springfield, OH Metropolitan Statistical Area
B|MT3945780000000|Toledo, OH Metropolitan Statistical Area
B|MT3948260000000|Weirton-Steubenville, WV-OH Metropolitan Statistical Area
B|MT3949660000000|Youngstown-Warren, OH Metropolitan Statistical Area
B|MT4021420000000|Enid, OK Metropolitan Statistical Area
B|MT4030020000000|Lawton, OK Metropolitan Statistical Area
B|MT4036420000000|Oklahoma City, OK Metropolitan Statistical Area
B|MT4046140000000|Tulsa, OK Metropolitan Statistical Area
B|MT4110540000000|Albany, OR Metropolitan Statistical Area
B|MT4113460000000|Bend, OR Metropolitan Statistical Area
B|MT4118700000000|Corvallis, OR Metropolitan Statistical Area
B|MT4121660000000|Eugene-Springfield, OR Metropolitan Statistical Area
B|MT4124420000000|Grants Pass, OR Metropolitan Statistical Area
B|MT4132780000000|Medford, OR Metropolitan Statistical Area
B|MT4138900000000|Portland-Vancouver-Hillsboro, OR-WA Metropolitan Statistical Area
B|MT4141420000000|Salem, OR Metropolitan Statistical Area
B|MT4210900000000|Allentown-Bethlehem-Easton, PA-NJ Metropolitan Statistical Area
B|MT4211020000000|Altoona, PA Metropolitan Statistical Area
B|MT4216540000000|Chambersburg, PA Metropolitan Statistical Area
B|MT4221500000000|Erie, PA Metropolitan Statistical Area
B|MT4223900000000|Gettysburg, PA Metropolitan Statistical Area
B|MT4225420000000|Harrisburg-Carlisle, PA Metropolitan Statistical Area
B|MT4227780000000|Johnstown, PA Metropolitan Statistical Area
B|MT4229540000000|Lancaster, PA Metropolitan Statistical Area
B|MT4230140000000|Lebanon, PA Metropolitan Statistical Area
B|MT4237980000000|Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area
B|MT4238300000000|Pittsburgh, PA Metropolitan Statistical Area
B|MT4239740000000|Reading, PA Metropolitan Statistical Area
B|MT4242540000000|Scranton--Wilkes-Barre, PA Metropolitan Statistical Area
B|MT4244300000000|State College, PA Metropolitan Statistical Area
B|MT4248700000000|Williamsport, PA Metropolitan Statistical Area
B|MT4249620000000|York-Hanover, PA Metropolitan Statistical Area
B|MT4439300000000|Providence-Warwick, RI-MA Metropolitan Statistical Area
B|MT4516700000000|Charleston-North Charleston, SC Metropolitan Statistical Area
B|MT4517900000000|Columbia, SC Metropolitan Statistical Area
B|MT4522500000000|Florence, SC Metropolitan Statistical Area
B|MT4524860000000|Greenville-Anderson-Greer, SC Metropolitan Statistical Area
B|MT4525940000000|Hilton Head Island-Bluffton-Port Royal, SC Metropolitan Statistical Area
B|MT4534820000000|Myrtle Beach-Conway-North Myrtle Beach, SC Metropolitan Statistical Area
B|MT4543900000000|Spartanburg, SC Metropolitan Statistical Area
B|MT4544940000000|Sumter, SC Metropolitan Statistical Area
B|MT4639660000000|Rapid City, SD Metropolitan Statistical Area
B|MT4643620000000|Sioux Falls, SD-MN Metropolitan Statistical Area
B|MT4716860000000|Chattanooga, TN-GA Metropolitan Statistical Area
B|MT4717300000000|Clarksville, TN-KY Metropolitan Statistical Area
B|MT4717420000000|Cleveland, TN Metropolitan Statistical Area
B|MT4727180000000|Jackson, TN Metropolitan Statistical Area
B|MT4727740000000|Johnson City, TN Metropolitan Statistical Area
B|MT4728700000000|Kingsport-Bristol, TN-VA Metropolitan Statistical Area
B|MT4728940000000|Knoxville, TN Metropolitan Statistical Area
B|MT4732820000000|Memphis, TN-MS-AR Metropolitan Statistical Area
B|MT4734100000000|Morristown, TN Metropolitan Statistical Area
B|MT4734980000000|Nashville-Davidson--Murfreesboro--Franklin, TN Metropolitan Statistical Area
B|MT4810180000000|Abilene, TX Metropolitan Statistical Area
B|MT4811100000000|Amarillo, TX Metropolitan Statistical Area
B|MT4812420000000|Austin-Round Rock-San Marcos, TX Metropolitan Statistical Area
B|MT4813140000000|Beaumont-Port Arthur, TX Metropolitan Statistical Area
B|MT4815180000000|Brownsville-Harlingen, TX Metropolitan Statistical Area
B|MT4817780000000|College Station-Bryan, TX Metropolitan Statistical Area
B|MT4818580000000|Corpus Christi, TX Metropolitan Statistical Area
B|MT4819100000000|Dallas-Fort Worth-Arlington, TX Metropolitan Statistical Area
B|MT4820580000000|Eagle Pass, TX Metropolitan Statistical Area
B|MT4821340000000|El Paso, TX Metropolitan Statistical Area
B|MT4826420000000|Houston-Pasadena-The Woodlands, TX Metropolitan Statistical Area
B|MT4828660000000|Killeen-Temple, TX Metropolitan Statistical Area
B|MT4829700000000|Laredo, TX Metropolitan Statistical Area
B|MT4830980000000|Longview, TX Metropolitan Statistical Area
B|MT4831180000000|Lubbock, TX Metropolitan Statistical Area
B|MT4832580000000|McAllen-Edinburg-Mission, TX Metropolitan Statistical Area
B|MT4833260000000|Midland, TX Metropolitan Statistical Area
B|MT4836220000000|Odessa, TX Metropolitan Statistical Area
B|MT4841660000000|San Angelo, TX Metropolitan Statistical Area
B|MT4841700000000|San Antonio-New Braunfels, TX Metropolitan Statistical Area
B|MT4843300000000|Sherman-Denison, TX Metropolitan Statistical Area
B|MT4845500000000|Texarkana, TX-AR Metropolitan Statistical Area
B|MT4846340000000|Tyler, TX Metropolitan Statistical Area
B|MT4847020000000|Victoria, TX Metropolitan Statistical Area
B|MT4847380000000|Waco, TX Metropolitan Statistical Area
B|MT4848660000000|Wichita Falls, TX Metropolitan Statistical Area
B|MT4930860000000|Logan, UT-ID Metropolitan Statistical Area
B|MT4936260000000|Ogden, UT Metropolitan Statistical Area
B|MT4939340000000|Provo-Orem-Lehi, UT Metropolitan Statistical Area
B|MT4941100000000|St. George, UT Metropolitan Statistical Area
B|MT4941620000000|Salt Lake City-Murray, UT Metropolitan Statistical Area
B|MT5015540000000|Burlington-South Burlington, VT Metropolitan Statistical Area
B|MT5113980000000|Blacksburg-Christiansburg-Radford, VA Metropolitan Statistical Area
B|MT5116820000000|Charlottesville, VA Metropolitan Statistical Area
B|MT5125500000000|Harrisonburg, VA Metropolitan Statistical Area
B|MT5131340000000|Lynchburg, VA Metropolitan Statistical Area
B|MT5140060000000|Richmond, VA Metropolitan Statistical Area
B|MT5140220000000|Roanoke, VA Metropolitan Statistical Area
B|MT5144420000000|Staunton-Stuarts Draft, VA Metropolitan Statistical Area
B|MT5147260000000|Virginia Beach-Chesapeake-Norfolk, VA-NC Metropolitan Statistical Area
B|MT5149020000000|Winchester, VA-WV Metropolitan Statistical Area
B|MT5313380000000|Bellingham, WA Metropolitan Statistical Area
B|MT5314740000000|Bremerton-Silverdale-Port Orchard, WA Metropolitan Statistical Area
B|MT5328420000000|Kennewick-Richland, WA Metropolitan Statistical Area
B|MT5331020000000|Longview-Kelso, WA Metropolitan Statistical Area
B|MT5334580000000|Mount Vernon-Anacortes, WA Metropolitan Statistical Area
B|MT5336500000000|Olympia-Lacey-Tumwater, WA Metropolitan Statistical Area
B|MT5342660000000|Seattle-Tacoma-Bellevue, WA Metropolitan Statistical Area
B|MT5344060000000|Spokane-Spokane Valley, WA Metropolitan Statistical Area
B|MT5347460000000|Walla Walla, WA Metropolitan Statistical Area
B|MT5348300000000|Wenatchee-East Wenatchee, WA Metropolitan Statistical Area
B|MT5349420000000|Yakima, WA Metropolitan Statistical Area
B|MT5413220000000|Beckley, WV Metropolitan Statistical Area
B|MT5416620000000|Charleston, WV Metropolitan Statistical Area
B|MT5426580000000|Huntington-Ashland, WV-KY-OH Metropolitan Statistical Area
B|MT5434060000000|Morgantown, WV Metropolitan Statistical Area
B|MT5437620000000|Parkersburg-Vienna, WV Metropolitan Statistical Area
B|MT5448540000000|Wheeling, WV-OH Metropolitan Statistical Area
B|MT5511540000000|Appleton, WI Metropolitan Statistical Area
B|MT5520740000000|Eau Claire, WI Metropolitan Statistical Area
B|MT5522540000000|Fond du Lac, WI Metropolitan Statistical Area
B|MT5524580000000|Green Bay, WI Metropolitan Statistical Area
B|MT5527500000000|Janesville-Beloit, WI Metropolitan Statistical Area
B|MT5528450000000|Kenosha, WI Metropolitan Statistical Area
B|MT5529100000000|La Crosse-Onalaska, WI-MN Metropolitan Statistical Area
B|MT5531540000000|Madison, WI Metropolitan Statistical Area
B|MT5533340000000|Milwaukee-Waukesha, WI Metropolitan Statistical Area
B|MT5536780000000|Oshkosh-Neenah, WI Metropolitan Statistical Area
B|MT5539540000000|Racine-Mount Pleasant, WI Metropolitan Statistical Area
B|MT5543100000000|Sheboygan, WI Metropolitan Statistical Area
B|MT5548140000000|Wausau, WI Metropolitan Statistical Area
B|MT5616220000000|Casper, WY Metropolitan Statistical Area
B|MT5616940000000|Cheyenne, WY Metropolitan Statistical Area
B|MT7210380000000|Aguadilla, PR Metropolitan Statistical Area
B|MT7211640000000|Arecibo, PR Metropolitan Statistical Area
B|MT7225020000000|Guayama, PR Metropolitan Statistical Area
B|MT7232420000000|Mayaguez, PR Metropolitan Statistical Area
B|MT7238660000000|Ponce, PR Metropolitan Statistical Area
B|MT7241980000000|San Juan-Bayamon-Caguas, PR Metropolitan Statistical Area
C|DV0611244000000|Anaheim-Santa Ana-Irvine, CA Metropolitan Division
C|DV0631084000000|Los Angeles-Long Beach-Glendale, CA Metropolitan Division
C|DV0636084000000|Oakland-Fremont-Berkeley, CA Metropolitan Division
C|DV0641884000000|San Francisco-San Mateo-Redwood City, CA Metropolitan Division
C|DV0642034000000|San Rafael, CA Metropolitan Division
C|DV1048864000000|Wilmington, DE-MD-NJ Metropolitan Division
C|DV1147764000000|Washington, DC-MD Metropolitan Division
C|DV1222744000000|Fort Lauderdale-Pompano Beach-Sunrise, FL Metropolitan Division
C|DV1233124000000|Miami-Miami Beach-Kendall, FL Metropolitan Division
C|DV1241304000000|St. Petersburg-Clearwater-Largo, FL Metropolitan Division
C|DV1245294000000|Tampa, FL Metropolitan Division
C|DV1248424000000|West Palm Beach-Boca Raton-Delray Beach, FL Metropolitan Division
C|DV1312054000000|Atlanta-Sandy Springs-Roswell, GA Metropolitan Division
C|DV1331924000000|Marietta, GA Metropolitan Division
C|DV1716984000000|Chicago-Naperville-Schaumburg, IL Metropolitan Division
C|DV1720994000000|Elgin, IL Metropolitan Division
C|DV1729404000000|Lake County, IL Metropolitan Division
C|DV1829414000000|Lake County-Porter County-Jasper County, IN Metropolitan Division
C|DV2423224000000|Frederick-Gaithersburg-Bethesda, MD Metropolitan Division
C|DV2514454000000|Boston, MA Metropolitan Division
C|DV2515764000000|Cambridge-Newton-Framingham, MA Metropolitan Division
C|DV2619804000000|Detroit-Dearborn-Livonia, MI Metropolitan Division
C|DV2647664000000|Warren-Troy-Farmington Hills, MI Metropolitan Division
C|DV3340484000000|Rockingham County-Strafford County, NH Metropolitan Division
C|DV3415804000000|Camden, NJ Metropolitan Division
C|DV3429484000000|Lakewood-New Brunswick, NJ Metropolitan Division
C|DV3435084000000|Newark, NJ Metropolitan Division
C|DV3635004000000|Nassau County-Suffolk County, NY Metropolitan Division
C|DV3635614000000|New York-Jersey City-White Plains, NY-NJ Metropolitan Division
C|DV4233874000000|Montgomery County-Bucks County-Chester County, PA Metropolitan Division
C|DV4237964000000|Philadelphia, PA Metropolitan Division
C|DV4819124000000|Dallas-Plano-Irving, TX Metropolitan Division
C|DV4823104000000|Fort Worth-Arlington-Grapevine, TX Metropolitan Division
C|DV5111694000000|Arlington-Alexandria-Reston, VA-WV Metropolitan Division
C|DV5321794000000|Everett, WA Metropolitan Division
C|DV5342644000000|Seattle-Bellevue-Kent, WA Metropolitan Division
C|DV5345104000000|Tacoma-Lakewood, WA Metropolitan Division
D|MC0110700000000|Albertville, AL Micropolitan Statistical Area
D|MC0110760000000|Alexander City, AL Micropolitan Statistical Area
D|MC0118980000000|Cullman, AL Micropolitan Statistical Area
D|MC0121460000000|Enterprise, AL Micropolitan Statistical Area
D|MC0121640000000|Eufaula, AL-GA Micropolitan Statistical Area
D|MC0122840000000|Fort Payne, AL Micropolitan Statistical Area
D|MC0137120000000|Ozark, AL Micropolitan Statistical Area
D|MC0140770000000|Russellville, AL Micropolitan Statistical Area
D|MC0142460000000|Scottsboro, AL Micropolitan Statistical Area
D|MC0142820000000|Selma, AL Micropolitan Statistical Area
D|MC0145180000000|Talladega-Sylacauga, AL Micropolitan Statistical Area
D|MC0145980000000|Troy, AL Micropolitan Statistical Area
D|MC0227940000000|Juneau, AK Micropolitan Statistical Area
D|MC0228540000000|Ketchikan, AK Micropolitan Statistical Area
D|MC0435700000000|Nogales, AZ Micropolitan Statistical Area
D|MC0437740000000|Payson, AZ Micropolitan Statistical Area
D|MC0440940000000|Safford, AZ Micropolitan Statistical Area
D|MC0443320000000|Show Low, AZ Micropolitan Statistical Area
D|MC0511660000000|Arkadelphia, AR Micropolitan Statistical Area
D|MC0512900000000|Batesville, AR Micropolitan Statistical Area
D|MC0514180000000|Blytheville, AR Micropolitan Statistical Area
D|MC0515780000000|Camden, AR Micropolitan Statistical Area
D|MC0520980000000|El Dorado, AR Micropolitan Statistical Area
D|MC0522620000000|Forrest City, AR Micropolitan Statistical Area
D|MC0525460000000|Harrison, AR Micropolitan Statistical Area
D|MC0531620000000|Magnolia, AR Micropolitan Statistical Area
D|MC0531680000000|Malvern, AR Micropolitan Statistical Area
D|MC0534260000000|Mountain Home, AR Micropolitan Statistical Area
D|MC0537500000000|Paragould, AR Micropolitan Statistical Area
D|MC0538220000000|Pine Bluff, AR Micropolitan Statistical Area
D|MC0540780000000|Russellville, AR Micropolitan Statistical Area
D|MC0542620000000|Searcy, AR Micropolitan Statistical Area
D|MC0613860000000|Bishop, CA Micropolitan Statistical Area
D|MC0617340000000|Clearlake, CA Micropolitan Statistical Area
D|MC0618860000000|Crescent City, CA Micropolitan Statistical Area
D|MC0621700000000|Eureka-Arcata, CA Micropolitan Statistical Area
D|MC0639780000000|Red Bluff, CA Micropolitan Statistical Area
D|MC0643760000000|Sonora, CA Micropolitan Statistical Area
D|MC0645000000000|Susanville, CA Micropolitan Statistical Area
D|MC0646020000000|Truckee-Grass Valley, CA Micropolitan Statistical Area
D|MC0646380000000|Ukiah, CA Micropolitan Statistical Area
D|MC0810480000000|Alamosa, CO Micropolitan Statistical Area
D|MC0814720000000|Breckenridge, CO Micropolitan Statistical Area
D|MC0815860000000|Canon City, CO Micropolitan Statistical Area
D|MC0820420000000|Durango, CO Micropolitan Statistical Area
D|MC0820780000000|Edwards, CO Micropolitan Statistical Area
D|MC0822820000000|Fort Morgan, CO Micropolitan Statistical Area
D|MC0833940000000|Montrose, CO Micropolitan Statistical Area
D|MC0840090000000|Rifle, CO Micropolitan Statistical Area
D|MC0844460000000|Steamboat Springs, CO Micropolitan Statistical Area
D|MC0844540000000|Sterling, CO Micropolitan Statistical Area
D|MC0939480000000|Putnam, CT Micropolitan Statistical Area
D|MC0945860000000|Torrington, CT Micropolitan Statistical Area
D|MC1042580000000|Seaford, DE Micropolitan Statistical Area
D|MC1211580000000|Arcadia, FL Micropolitan Statistical Area
D|MC1217500000000|Clewiston, FL Micropolitan Statistical Area
D|MC1228580000000|Key West-Key Largo, FL Micropolitan Statistical Area
D|MC1229380000000|Lake City, FL Micropolitan Statistical Area
D|MC1236380000000|Okeechobee, FL Micropolitan Statistical Area
D|MC1237260000000|Palatka, FL Micropolitan Statistical Area
D|MC1311140000000|Americus, GA Micropolitan Statistical Area
D|MC1312460000000|Bainbridge, GA Micropolitan Statistical Area
D|MC1315660000000|Calhoun, GA Micropolitan Statistical Area
D|MC1316340000000|Cedartown, GA Micropolitan Statistical Area
D|MC1318380000000|Cordele, GA Micropolitan Statistical Area
D|MC1318460000000|Cornelia, GA Micropolitan Statistical Area
D|MC1320060000000|Douglas, GA Micropolitan Statistical Area
D|MC1320140000000|Dublin, GA Micropolitan Statistical Area
D|MC1322340000000|Fitzgerald, GA Micropolitan Statistical Area
D|MC1327600000000|Jefferson, GA Micropolitan Statistical Area
D|MC1327700000000|Jesup, GA Micropolitan Statistical Area
D|MC1328680000000|Kingsland, GA Micropolitan Statistical Area
D|MC1329300000000|LaGrange, GA-AL Micropolitan Statistical Area
D|MC1333300000000|Milledgeville, GA Micropolitan Statistical Area
D|MC1334220000000|Moultrie, GA Micropolitan Statistical Area
D|MC1344340000000|Statesboro, GA Micropolitan Statistical Area
D|MC1344900000000|Summerville, GA Micropolitan Statistical Area
D|MC1345580000000|Thomaston, GA Micropolitan Statistical Area
D|MC1345620000000|Thomasville, GA Micropolitan Statistical Area
D|MC1345700000000|Tifton, GA Micropolitan Statistical Area
D|MC1345740000000|Toccoa, GA Micropolitan Statistical Area
D|MC1347080000000|Vidalia, GA Micropolitan Statistical Area
D|MC1348180000000|Waycross, GA Micropolitan Statistical Area
D|MC1525900000000|Hilo-Kailua, HI Micropolitan Statistical Area
D|MC1528180000000|Kapaa, HI Micropolitan Statistical Area
D|MC1613940000000|Blackfoot, ID Micropolitan Statistical Area
D|MC1615420000000|Burley, ID Micropolitan Statistical Area
D|MC1625200000000|Hailey, ID Micropolitan Statistical Area
D|MC1634140000000|Moscow, ID Micropolitan Statistical Area
D|MC1634300000000|Mountain Home, ID Micropolitan Statistical Area
D|MC1639940000000|Rexburg, ID Micropolitan Statistical Area
D|MC1641760000000|Sandpoint, ID Micropolitan Statistical Area
D|MC1715900000000|Canton, IL Micropolitan Statistical Area
D|MC1716060000000|Carbondale, IL Micropolitan Statistical Area
D|MC1716460000000|Centralia, IL Micropolitan Statistical Area
D|MC1716660000000|Charleston-Mattoon, IL Micropolitan Statistical Area
D|MC1719180000000|Danville, IL Micropolitan Statistical Area
D|MC1719940000000|Dixon, IL Micropolitan Statistical Area
D|MC1720820000000|Effingham, IL Micropolitan Statistical Area
D|MC1723300000000|Freeport, IL Micropolitan Statistical Area
D|MC1723660000000|Galesburg, IL Micropolitan Statistical Area
D|MC1727300000000|Jacksonville, IL Micropolitan Statistical Area
D|MC1730660000000|Lincoln, IL Micropolitan Statistical Area
D|MC1731380000000|Macomb, IL Micropolitan Statistical Area
D|MC1732060000000|Marion-Herrin, IL Micropolitan Statistical Area
D|MC1734500000000|Mount Vernon, IL Micropolitan Statistical Area
D|MC1736837000000|Ottawa, IL Micropolitan Statistical Area
D|MC1738700000000|Pontiac, IL Micropolitan Statistical Area
D|MC1739500000000|Quincy, IL-MO Micropolitan Statistical Area
D|MC1740300000000|Rochelle, IL Micropolitan Statistical Area
D|MC1744580000000|Sterling, IL Micropolitan Statistical Area
D|MC1745380000000|Taylorville, IL Micropolitan Statistical Area
D|MC1811420000000|Angola, IN Micropolitan Statistical Area
D|MC1812140000000|Auburn, IN Micropolitan Statistical Area
D|MC1813260000000|Bedford, IN Micropolitan Statistical Area
D|MC1818220000000|Connersville, IN Micropolitan Statistical Area
D|MC1818820000000|Crawfordsville, IN Micropolitan Statistical Area
D|MC1819540000000|Decatur, IN Micropolitan Statistical Area
D|MC1823140000000|Frankfort, IN Micropolitan Statistical Area
D|MC1824600000000|Greencastle, IN Micropolitan Statistical Area
D|MC1824700000000|Greensburg, IN Micropolitan Statistical Area
D|MC1826540000000|Huntington, IN Micropolitan Statistical Area
D|MC1827540000000|Jasper, IN Micropolitan Statistical Area
D|MC1828340000000|Kendallville, IN Micropolitan Statistical Area
D|MC1830900000000|Logansport, IN Micropolitan Statistical Area
D|MC1831500000000|Madison, IN Micropolitan Statistical Area
D|MC1831980000000|Marion, IN Micropolitan Statistical Area
D|MC1833900000000|Monticello, IN Micropolitan Statistical Area
D|MC1835220000000|New Castle, IN Micropolitan Statistical Area
D|MC1837940000000|Peru, IN Micropolitan Statistical Area
D|MC1838500000000|Plymouth, IN Micropolitan Statistical Area
D|MC1839980000000|Richmond, IN Micropolitan Statistical Area
D|MC1842980000000|Seymour, IN Micropolitan Statistical Area
D|MC1847180000000|Vincennes, IN Micropolitan Statistical Area
D|MC1847340000000|Wabash, IN Micropolitan Statistical Area
D|MC1847700000000|Warsaw, IN Micropolitan Statistical Area
D|MC1847780000000|Washington, IN Micropolitan Statistical Area
D|MC1915460000000|Burlington, IA-IL Micropolitan Statistical Area
D|MC1916140000000|Carroll, IA Micropolitan Statistical Area
D|MC1917540000000|Clinton, IA Micropolitan Statistical Area
D|MC1922700000000|Fort Dodge, IA Micropolitan Statistical Area
D|MC1922800000000|Fort Madison, IA Micropolitan Statistical Area
D|MC1930180000000|Le Mars, IA Micropolitan Statistical Area
D|MC1932260000000|Marshalltown, IA Micropolitan Statistical Area
D|MC1932380000000|Mason City, IA Micropolitan Statistical Area
D|MC1934700000000|Muscatine, IA Micropolitan Statistical Area
D|MC1936820000000|Oskaloosa, IA Micropolitan Statistical Area
D|MC1936900000000|Ottumwa, IA Micropolitan Statistical Area
D|MC1937800000000|Pella, IA Micropolitan Statistical Area
D|MC1943980000000|Spencer, IA Micropolitan Statistical Area
D|MC1944020000000|Spirit Lake, IA Micropolitan Statistical Area
D|MC1944740000000|Storm Lake, IA Micropolitan Statistical Area
D|MC2011680000000|Arkansas City-Winfield, KS Micropolitan Statistical Area
D|MC2011860000000|Atchison, KS Micropolitan Statistical Area
D|MC2019980000000|Dodge City, KS Micropolitan Statistical Area
D|MC2021380000000|Emporia, KS Micropolitan Statistical Area
D|MC2023780000000|Garden City, KS Micropolitan Statistical Area
D|MC2024460000000|Great Bend, KS Micropolitan Statistical Area
D|MC2025700000000|Hays, KS Micropolitan Statistical Area
D|MC2026740000000|Hutchinson, KS Micropolitan Statistical Area
D|MC2030580000000|Liberal, KS Micropolitan Statistical Area
D|MC2032700000000|McPherson, KS Micropolitan Statistical Area
D|MC2036840000000|Ottawa, KS Micropolitan Statistical Area
D|MC2038260000000|Pittsburg, KS Micropolitan Statistical Area
D|MC2041460000000|Salina, KS Micropolitan Statistical Area
D|MC2115820000000|Campbellsville, KY Micropolitan Statistical Area
D|MC2118340000000|Corbin, KY Micropolitan Statistical Area
D|MC2119220000000|Danville, KY Micropolitan Statistical Area
D|MC2123180000000|Frankfort, KY Micropolitan Statistical Area
D|MC2123190000000|Franklin, KY Micropolitan Statistical Area
D|MC2123980000000|Glasgow, KY Micropolitan Statistical Area
D|MC2125775000000|Henderson, KY Micropolitan Statistical Area
D|MC2131580000000|Madisonville, KY Micropolitan Statistical Area
D|MC2132460000000|Mayfield, KY Micropolitan Statistical Area
D|MC2133180000000|Middlesborough, KY Micropolitan Statistical Area
D|MC2134460000000|Mount Sterling, KY Micropolitan Statistical Area
D|MC2134660000000|Murray, KY Micropolitan Statistical Area
D|MC2138210000000|Pikeville, KY Micropolitan Statistical Area
D|MC2140080000000|Richmond-Berea, KY Micropolitan Statistical Area
D|MC2143700000000|Somerset, KY Micropolitan Statistical Area
D|MC2214220000000|Bogalusa, LA Micropolitan Statistical Area
D|MC2219760000000|DeRidder, LA Micropolitan Statistical Area
D|MC2233380000000|Minden, LA Micropolitan Statistical Area
D|MC2234020000000|Morgan City, LA Micropolitan Statistical Area
D|MC2235060000000|Natchitoches, LA Micropolitan Statistical Area
D|MC2235340000000|New Iberia, LA Micropolitan Statistical Area
D|MC2236660000000|Opelousas, LA Micropolitan Statistical Area
D|MC2240820000000|Ruston, LA Micropolitan Statistical Area
D|MC2312300000000|Augusta-Waterville, ME Micropolitan Statistical Area
D|MC2415700000000|Cambridge, MD Micropolitan Statistical Area
D|MC2419060000000|Cumberland, MD-WV Micropolitan Statistical Area
D|MC2420660000000|Easton, MD Micropolitan Statistical Area
D|MC2436180000000|Ocean Pines, MD Micropolitan Statistical Area
D|MC2524640000000|Greenfield, MA Micropolitan Statistical Area
D|MC2534880000000|Nantucket, MA Micropolitan Statistical Area
D|MC2547240000000|Vineyard Haven, MA Micropolitan Statistical Area
D|MC2610300000000|Adrian, MI Micropolitan Statistical Area
D|MC2610940000000|Alma, MI Micropolitan Statistical Area
D|MC2610980000000|Alpena, MI Micropolitan Statistical Area
D|MC2613660000000|Big Rapids, MI Micropolitan Statistical Area
D|MC2615620000000|Cadillac, MI Micropolitan Statistical Area
D|MC2617740000000|Coldwater, MI Micropolitan Statistical Area
D|MC2621540000000|Escanaba, MI Micropolitan Statistical Area
D|MC2625880000000|Hillsdale, MI Micropolitan Statistical Area
D|MC2626090000000|Holland, MI Micropolitan Statistical Area
D|MC2626340000000|Houghton, MI Micropolitan Statistical Area
D|MC2627020000000|Iron Mountain, MI-WI Micropolitan Statistical Area
D|MC2631220000000|Ludington, MI Micropolitan Statistical Area
D|MC2632100000000|Marquette, MI Micropolitan Statistical Area
D|MC2634380000000|Mount Pleasant, MI Micropolitan Statistical Area
D|MC2637020000000|Owosso, MI Micropolitan Statistical Area
D|MC2637950000000|Petoskey, MI Micropolitan Statistical Area
D|MC2642300000000|Sault Ste. Marie, MI Micropolitan Statistical Area
D|MC2644780000000|Sturgis, MI Micropolitan Statistical Area
D|MC2710660000000|Albert Lea, MN Micropolitan Statistical Area
D|MC2710820000000|Alexandria, MN Micropolitan Statistical Area
D|MC2712380000000|Austin, MN Micropolitan Statistical Area
D|MC2713420000000|Bemidji, MN Micropolitan Statistical Area
D|MC2714660000000|Brainerd, MN Micropolitan Statistical Area
D|MC2719810000000|Detroit Lakes, MN Micropolitan Statistical Area
D|MC2721860000000|Fairmont, MN Micropolitan Statistical Area
D|MC2722060000000|Faribault-Northfield, MN Micropolitan Statistical Area
D|MC2722260000000|Fergus Falls, MN Micropolitan Statistical Area
D|MC2724330000000|Grand Rapids, MN Micropolitan Statistical Area
D|MC2726780000000|Hutchinson, MN Micropolitan Statistical Area
D|MC2732140000000|Marshall, MN Micropolitan Statistical Area
D|MC2735580000000|New Ulm, MN Micropolitan Statistical Area
D|MC2736940000000|Owatonna, MN Micropolitan Statistical Area
D|MC2739860000000|Red Wing, MN Micropolitan Statistical Area
D|MC2748820000000|Willmar, MN Micropolitan Statistical Area
D|MC2749100000000|Winona, MN Micropolitan Statistical Area
D|MC2749380000000|Worthington, MN Micropolitan Statistical Area
D|MC2815020000000|Brookhaven, MS Micropolitan Statistical Area
D|MC2817260000000|Clarksdale, MS Micropolitan Statistical Area
D|MC2817380000000|Cleveland, MS Micropolitan Statistical Area
D|MC2818060000000|Columbus, MS Micropolitan Statistical Area
D|MC2818420000000|Corinth, MS Micropolitan Statistical Area
D|MC2824740000000|Greenville, MS Micropolitan Statistical Area
D|MC2824900000000|Greenwood, MS Micropolitan Statistical Area
D|MC2824980000000|Grenada, MS Micropolitan Statistical Area
D|MC2829860000000|Laurel, MS Micropolitan Statistical Area
D|MC2832620000000|McComb, MS Micropolitan Statistical Area
D|MC2832940000000|Meridian, MS Micropolitan Statistical Area
D|MC2835020000000|Natchez, MS-LA Micropolitan Statistical Area
D|MC2837060000000|Oxford, MS Micropolitan Statistical Area
D|MC2838100000000|Picayune, MS Micropolitan Statistical Area
D|MC2844260000000|Starkville, MS Micropolitan Statistical Area
D|MC2846180000000|Tupelo, MS Micropolitan Statistical Area
D|MC2846980000000|Vicksburg, MS Micropolitan Statistical Area
D|MC2914700000000|Branson, MO Micropolitan Statistical Area
D|MC2922100000000|Farmington, MO Micropolitan Statistical Area
D|MC2922780000000|Fort Leonard Wood, MO Micropolitan Statistical Area
D|MC2925300000000|Hannibal, MO Micropolitan Statistical Area
D|MC2928380000000|Kennett, MO Micropolitan Statistical Area
D|MC2928860000000|Kirksville, MO Micropolitan Statistical Area
D|MC2930060000000|Lebanon, MO Micropolitan Statistical Area
D|MC2932180000000|Marshall, MO Micropolitan Statistical Area
D|MC2932340000000|Maryville, MO Micropolitan Statistical Area
D|MC2933020000000|Mexico, MO Micropolitan Statistical Area
D|MC2933620000000|Moberly, MO Micropolitan Statistical Area
D|MC2938740000000|Poplar Bluff, MO Micropolitan Statistical Area
D|MC2940620000000|Rolla, MO Micropolitan Statistical Area
D|MC2942740000000|Sedalia, MO Micropolitan Statistical Area
D|MC2943460000000|Sikeston, MO Micropolitan Statistical Area
D|MC2947660000000|Warrensburg, MO Micropolitan Statistical Area
D|MC2948460000000|West Plains, MO Micropolitan Statistical Area
D|MC3015580000000|Butte-Silver Bow, MT Micropolitan Statistical Area
D|MC3028060000000|Kalispell, MT Micropolitan Statistical Area
D|MC3113100000000|Beatrice, NE Micropolitan Statistical Area
D|MC3118100000000|Columbus, NE Micropolitan Statistical Area
D|MC3123340000000|Fremont, NE Micropolitan Statistical Area
D|MC3125580000000|Hastings, NE Micropolitan Statistical Area
D|MC3128260000000|Kearney, NE Micropolitan Statistical Area
D|MC3130420000000|Lexington, NE Micropolitan Statistical Area
D|MC3135740000000|Norfolk, NE Micropolitan Statistical Area
D|MC3135820000000|North Platte, NE Micropolitan Statistical Area
D|MC3142420000000|Scottsbluff, NE Micropolitan Statistical Area
D|MC3221220000000|Elko, NV Micropolitan Statistical Area
D|MC3221980000000|Fallon, NV Micropolitan Statistical Area
D|MC3223820000000|Gardnerville Ranchos, NV-CA Micropolitan Statistical Area
D|MC3237220000000|Pahrump, NV Micropolitan Statistical Area
D|MC3249080000000|Winnemucca, NV Micropolitan Statistical Area
D|MC3318180000000|Concord, NH Micropolitan Statistical Area
D|MC3328300000000|Keene, NH Micropolitan Statistical Area
D|MC3329060000000|Laconia, NH Micropolitan Statistical Area
D|MC3330150000000|Lebanon-Claremont, NH-VT Micropolitan Statistical Area
D|MC3510460000000|Alamogordo, NM Micropolitan Statistical Area
D|MC3516100000000|Carlsbad-Artesia, NM Micropolitan Statistical Area
D|MC3517580000000|Clovis, NM Micropolitan Statistical Area
D|MC3519700000000|Deming, NM Micropolitan Statistical Area
D|MC3521580000000|Espanola, NM Micropolitan Statistical Area
D|MC3523700000000|Gallup, NM Micropolitan Statistical Area
D|MC3526020000000|Hobbs, NM Micropolitan Statistical Area
D|MC3529780000000|Las Vegas, NM Micropolitan Statistical Area
D|MC3531060000000|Los Alamos, NM Micropolitan Statistical Area
D|MC3540740000000|Roswell, NM Micropolitan Statistical Area
D|MC3540760000000|Ruidoso, NM Micropolitan Statistical Area
D|MC3543500000000|Silver City, NM Micropolitan Statistical Area
D|MC3545340000000|Taos, NM Micropolitan Statistical Area
D|MC3611220000000|Amsterdam, NY Micropolitan Statistical Area
D|MC3612180000000|Auburn, NY Micropolitan Statistical Area
D|MC3612860000000|Batavia, NY Micropolitan Statistical Area
D|MC3618500000000|Corning, NY Micropolitan Statistical Area
D|MC3618660000000|Cortland, NY Micropolitan Statistical Area
D|MC3624100000000|Gloversville, NY Micropolitan Statistical Area
D|MC3626460000000|Hudson, NY Micropolitan Statistical Area
D|MC3627460000000|Jamestown-Dunkirk, NY Micropolitan Statistical Area
D|MC3632390000000|Massena-Ogdensburg, NY Micropolitan Statistical Area
D|MC3633910000000|Monticello, NY Micropolitan Statistical Area
D|MC3636460000000|Olean, NY Micropolitan Statistical Area
D|MC3636580000000|Oneonta, NY Micropolitan Statistical Area
D|MC3638460000000|Plattsburgh, NY Micropolitan Statistical Area
D|MC3642900000000|Seneca Falls, NY Micropolitan Statistical Area
D|MC3710620000000|Albemarle, NC Micropolitan Statistical Area
D|MC3711360000000|Anderson Creek, NC Micropolitan Statistical Area
D|MC3714380000000|Boone, NC Micropolitan Statistical Area
D|MC3714820000000|Brevard, NC Micropolitan Statistical Area
D|MC3721020000000|Elizabeth City, NC Micropolitan Statistical Area
D|MC3722580000000|Forest City, NC Micropolitan Statistical Area
D|MC3725780000000|Henderson, NC Micropolitan Statistical Area
D|MC3728620000000|Kill Devil Hills, NC Micropolitan Statistical Area
D|MC3728820000000|Kinston, NC Micropolitan Statistical Area
D|MC3729900000000|Laurinburg, NC Micropolitan Statistical Area
D|MC3731300000000|Lumberton, NC Micropolitan Statistical Area
D|MC3732000000000|Marion, NC Micropolitan Statistical Area
D|MC3733980000000|Morehead City, NC Micropolitan Statistical Area
D|MC3734340000000|Mount Airy, NC Micropolitan Statistical Area
D|MC3735100000000|New Bern, NC Micropolitan Statistical Area
D|MC3735900000000|North Wilkesboro, NC Micropolitan Statistical Area
D|MC3740260000000|Roanoke Rapids, NC Micropolitan Statistical Area
D|MC3740460000000|Rockingham, NC Micropolitan Statistical Area
D|MC3741820000000|Sanford, NC Micropolitan Statistical Area
D|MC3743140000000|Shelby-Kings Mountain, NC Micropolitan Statistical Area
D|MC3747820000000|Washington, NC Micropolitan Statistical Area
D|MC3748200000000|Waynesville, NC Micropolitan Statistical Area
D|MC3748980000000|Wilson, NC Micropolitan Statistical Area
D|MC3819860000000|Dickinson, ND Micropolitan Statistical Area
D|MC3827420000000|Jamestown, ND Micropolitan Statistical Area
D|MC3847420000000|Wahpeton, ND-MN Micropolitan Statistical Area
D|MC3848780000000|Williston, ND Micropolitan Statistical Area
D|MC3911740000000|Ashland, OH Micropolitan Statistical Area
D|MC3911900000000|Athens, OH Micropolitan Statistical Area
D|MC3913340000000|Bellefontaine, OH Micropolitan Statistical Area
D|MC3915340000000|Bucyrus, OH Micropolitan Statistical Area
D|MC3915740000000|Cambridge, OH Micropolitan Statistical Area
D|MC3916380000000|Celina, OH Micropolitan Statistical Area
D|MC3917060000000|Chillicothe, OH Micropolitan Statistical Area
D|MC3918740000000|Coshocton, OH Micropolitan Statistical Area
D|MC3919580000000|Defiance, OH Micropolitan Statistical Area
D|MC3922300000000|Findlay, OH Micropolitan Statistical Area
D|MC3923380000000|Fremont, OH Micropolitan Statistical Area
D|MC3923680000000|Gallipolis, OH Micropolitan Statistical Area
D|MC3924820000000|Greenville, OH Micropolitan Statistical Area
D|MC3931930000000|Marietta, OH Micropolitan Statistical Area
D|MC3932020000000|Marion, OH Micropolitan Statistical Area
D|MC3934540000000|Mount Vernon, OH Micropolitan Statistical Area
D|MC3935420000000|New Philadelphia-Dover, OH Micropolitan Statistical Area
D|MC3935940000000|Norwalk, OH Micropolitan Statistical Area
D|MC3939020000000|Portsmouth, OH Micropolitan Statistical Area
D|MC3941400000000|Salem, OH Micropolitan Statistical Area
D|MC3943380000000|Sidney, OH Micropolitan Statistical Area
D|MC3945660000000|Tiffin, OH Micropolitan Statistical Area
D|MC3946500000000|Urbana, OH Micropolitan Statistical Area
D|MC3946780000000|Van Wert, OH Micropolitan Statistical Area
D|MC3947540000000|Wapakoneta, OH Micropolitan Statistical Area
D|MC3947920000000|Washington Court House, OH Micropolitan Statistical Area
D|MC3948940000000|Wilmington, OH Micropolitan Statistical Area
D|MC3949300000000|Wooster, OH Micropolitan Statistical Area
D|MC3949780000000|Zanesville, OH Micropolitan Statistical Area
D|MC4010220000000|Ada, OK Micropolitan Statistical Area
D|MC4011060000000|Altus, OK Micropolitan Statistical Area
D|MC4011620000000|Ardmore, OK Micropolitan Statistical Area
D|MC4012780000000|Bartlesville, OK Micropolitan Statistical Area
D|MC4020340000000|Duncan, OK Micropolitan Statistical Area
D|MC4020460000000|Durant, OK Micropolitan Statistical Area
D|MC4021120000000|Elk City, OK Micropolitan Statistical Area
D|MC4025100000000|Guymon, OK Micropolitan Statistical Area
D|MC4032540000000|McAlester, OK Micropolitan Statistical Area
D|MC4033060000000|Miami, OK Micropolitan Statistical Area
D|MC4034780000000|Muskogee, OK Micropolitan Statistical Area
D|MC4038620000000|Ponca City, OK Micropolitan Statistical Area
D|MC4043060000000|Shawnee, OK Micropolitan Statistical Area
D|MC4044660000000|Stillwater, OK Micropolitan Statistical Area
D|MC4045140000000|Tahlequah, OK Micropolitan Statistical Area
D|MC4048220000000|Weatherford, OK Micropolitan Statistical Area
D|MC4049260000000|Woodward, OK Micropolitan Statistical Area
D|MC4111820000000|Astoria, OR Micropolitan Statistical Area
D|MC4112520000000|Baker City, OR Micropolitan Statistical Area
D|MC4115060000000|Brookings, OR Micropolitan Statistical Area
D|MC4118300000000|Coos Bay-North Bend, OR Micropolitan Statistical Area
D|MC4125840000000|Hermiston-Pendleton, OR Micropolitan Statistical Area
D|MC4126220000000|Hood River, OR Micropolitan Statistical Area
D|MC4128900000000|Klamath Falls, OR Micropolitan Statistical Area
D|MC4129260000000|La Grande, OR Micropolitan Statistical Area
D|MC4135440000000|Newport, OR Micropolitan Statistical Area
D|MC4136620000000|Ontario, OR-ID Micropolitan Statistical Area
D|MC4140700000000|Roseburg, OR Micropolitan Statistical Area
D|MC4145520000000|The Dalles, OR Micropolitan Statistical Area
D|MC4214100000000|Bloomsburg-Berwick, PA Micropolitan Statistical Area
D|MC4214620000000|Bradford, PA Micropolitan Statistical Area
D|MC4220180000000|DuBois, PA Micropolitan Statistical Area
D|MC4220700000000|East Stroudsburg, PA Micropolitan Statistical Area
D|MC4225770000000|Hemlock Farms, PA Micropolitan Statistical Area
D|MC4225850000000|Hermitage, PA Micropolitan Statistical Area
D|MC4226500000000|Huntingdon, PA Micropolitan Statistical Area
D|MC4226860000000|Indiana, PA Micropolitan Statistical Area
D|MC4230260000000|Lewisburg, PA Micropolitan Statistical Area
D|MC4230380000000|Lewistown, PA Micropolitan Statistical Area
D|MC4230820000000|Lock Haven, PA Micropolitan Statistical Area
D|MC4232740000000|Meadville, PA Micropolitan Statistical Area
D|MC4236340000000|Oil City, PA Micropolitan Statistical Area
D|MC4239060000000|Pottsville, PA Micropolitan Statistical Area
D|MC4241260000000|St. Marys, PA Micropolitan Statistical Area
D|MC4242380000000|Sayre, PA Micropolitan Statistical Area
D|MC4242780000000|Selinsgrove, PA Micropolitan Statistical Area
D|MC4243740000000|Somerset, PA Micropolitan Statistical Area
D|MC4244980000000|Sunbury, PA Micropolitan Statistical Area
D|MC4247620000000|Warren, PA Micropolitan Statistical Area
D|MC4523500000000|Gaffney, SC Micropolitan Statistical Area
D|MC4524940000000|Greenwood, SC Micropolitan Statistical Area
D|MC4534680000000|Murrells Inlet, SC Micropolitan Statistical Area
D|MC4535140000000|Newberry, SC Micropolitan Statistical Area
D|MC4536700000000|Orangeburg, SC Micropolitan Statistical Area
D|MC4542860000000|Seneca, SC Micropolitan Statistical Area
D|MC4610100000000|Aberdeen, SD Micropolitan Statistical Area
D|MC4615100000000|Brookings, SD Micropolitan Statistical Area
D|MC4626700000000|Huron, SD Micropolitan Statistical Area
D|MC4633580000000|Mitchell, SD Micropolitan Statistical Area
D|MC4638180000000|Pierre, SD Micropolitan Statistical Area
D|MC4643940000000|Spearfish, SD Micropolitan Statistical Area
D|MC4646820000000|Vermillion, SD Micropolitan Statistical Area
D|MC4647980000000|Watertown, SD Micropolitan Statistical Area
D|MC4649460000000|Yankton, SD Micropolitan Statistical Area
D|MC4711940000000|Athens, TN Micropolitan Statistical Area
D|MC4718260000000|Cookeville, TN Micropolitan Statistical Area
D|MC4718900000000|Crossville, TN Micropolitan Statistical Area
D|MC4720540000000|Dyersburg, TN Micropolitan Statistical Area
D|MC4722190000000|Fayetteville, TN Micropolitan Statistical Area
D|MC4724620000000|Greeneville, TN Micropolitan Statistical Area
D|MC4729980000000|Lawrenceburg, TN Micropolitan Statistical Area
D|MC4730280000000|Lewisburg, TN Micropolitan Statistical Area
D|MC4732280000000|Martin, TN Micropolitan Statistical Area
D|MC4732660000000|McMinnville, TN Micropolitan Statistical Area
D|MC4735460000000|Newport, TN Micropolitan Statistical Area
D|MC4737540000000|Paris, TN Micropolitan Statistical Area
D|MC4742940000000|Sevierville, TN Micropolitan Statistical Area
D|MC4743180000000|Shelbyville, TN Micropolitan Statistical Area
D|MC4746100000000|Tullahoma-Manchester, TN Micropolitan Statistical Area
D|MC4746460000000|Union City, TN Micropolitan Statistical Area
D|MC4749010000000|Winchester, TN Micropolitan Statistical Area
D|MC4810860000000|Alice, TX Micropolitan Statistical Area
D|MC4811380000000|Andrews, TX Micropolitan Statistical Area
D|MC4811980000000|Athens, TX Micropolitan Statistical Area
D|MC4813060000000|Bay City, TX Micropolitan Statistical Area
D|MC4813300000000|Beeville, TX Micropolitan Statistical Area
D|MC4813700000000|Big Spring, TX Micropolitan Statistical Area
D|MC4814300000000|Bonham, TX Micropolitan Statistical Area
D|MC4814420000000|Borger, TX Micropolitan Statistical Area
D|MC4814780000000|Brenham, TX Micropolitan Statistical Area
D|MC4815220000000|Brownwood, TX Micropolitan Statistical Area
D|MC4818620000000|Corsicana, TX Micropolitan Statistical Area
D|MC4819620000000|Del Rio, TX Micropolitan Statistical Area
D|MC4820300000000|Dumas, TX Micropolitan Statistical Area
D|MC4820900000000|El Campo, TX Micropolitan Statistical Area
D|MC4823240000000|Fredericksburg, TX Micropolitan Statistical Area
D|MC4823620000000|Gainesville, TX Micropolitan Statistical Area
D|MC4824180000000|Granbury, TX Micropolitan Statistical Area
D|MC4825820000000|Hereford, TX Micropolitan Statistical Area
D|MC4826660000000|Huntsville, TX Micropolitan Statistical Area
D|MC4827380000000|Jacksonville, TX Micropolitan Statistical Area
D|MC4828500000000|Kerrville, TX Micropolitan Statistical Area
D|MC4828780000000|Kingsville, TX Micropolitan Statistical Area
D|MC4831260000000|Lufkin, TX Micropolitan Statistical Area
D|MC4833420000000|Mineral Wells, TX Micropolitan Statistical Area
D|MC4834420000000|Mount Pleasant, TX Micropolitan Statistical Area
D|MC4834860000000|Nacogdoches, TX Micropolitan Statistical Area
D|MC4837300000000|Palestine, TX Micropolitan Statistical Area
D|MC4837420000000|Pampa, TX Micropolitan Statistical Area
D|MC4837580000000|Paris, TX Micropolitan Statistical Area
D|MC4838380000000|Plainview, TX Micropolitan Statistical Area
D|MC4838920000000|Port Lavaca, TX Micropolitan Statistical Area
D|MC4839700000000|Raymondville, TX Micropolitan Statistical Area
D|MC4840100000000|Rio Grande City-Roma, TX Micropolitan Statistical Area
D|MC4843660000000|Snyder, TX Micropolitan Statistical Area
D|MC4844500000000|Stephenville, TX Micropolitan Statistical Area
D|MC4844860000000|Sulphur Springs, TX Micropolitan Statistical Area
D|MC4845020000000|Sweetwater, TX Micropolitan Statistical Area
D|MC4845880000000|Town of Pecos, TX Micropolitan Statistical Area
D|MC4846620000000|Uvalde, TX Micropolitan Statistical Area
D|MC4846900000000|Vernon, TX Micropolitan Statistical Area
D|MC4849820000000|Zapata, TX Micropolitan Statistical Area
D|MC4914940000000|Brigham City, UT-ID Micropolitan Statistical Area
D|MC4916260000000|Cedar City, UT Micropolitan Statistical Area
D|MC4925720000000|Heber, UT Micropolitan Statistical Area
D|MC4939220000000|Price, UT Micropolitan Statistical Area
D|MC4946860000000|Vernal, UT Micropolitan Statistical Area
D|MC5012740000000|Barre, VT Micropolitan Statistical Area
D|MC5013540000000|Bennington, VT Micropolitan Statistical Area
D|MC5014710000000|Brattleboro, VT Micropolitan Statistical Area
D|MC5040860000000|Rutland, VT Micropolitan Statistical Area
D|MC5119260000000|Danville, VA Micropolitan Statistical Area
D|MC5129470000000|Lake of the Woods, VA Micropolitan Statistical Area
D|MC5132300000000|Martinsville, VA Micropolitan Statistical Area
D|MC5310140000000|Aberdeen, WA Micropolitan Statistical Area
D|MC5316500000000|Centralia, WA Micropolitan Statistical Area
D|MC5321260000000|Ellensburg, WA Micropolitan Statistical Area
D|MC5334180000000|Moses Lake, WA Micropolitan Statistical Area
D|MC5336020000000|Oak Harbor, WA Micropolitan Statistical Area
D|MC5336830000000|Othello, WA Micropolitan Statistical Area
D|MC5338820000000|Port Angeles, WA Micropolitan Statistical Area
D|MC5339040000000|Port Townsend, WA Micropolitan Statistical Area
D|MC5339420000000|Pullman, WA Micropolitan Statistical Area
D|MC5343220000000|Shelton, WA Micropolitan Statistical Area
D|MC5414140000000|Bluefield, WV-VA Micropolitan Statistical Area
D|MC5417220000000|Clarksburg, WV Micropolitan Statistical Area
D|MC5421180000000|Elkins, WV Micropolitan Statistical Area
D|MC5421900000000|Fairmont, WV Micropolitan Statistical Area
D|MC5512660000000|Baraboo, WI Micropolitan Statistical Area
D|MC5513180000000|Beaver Dam, WI Micropolitan Statistical Area
D|MC5531820000000|Manitowoc, WI Micropolitan Statistical Area
D|MC5531940000000|Marinette, WI-MI Micropolitan Statistical Area
D|MC5532860000000|Menomonie, WI Micropolitan Statistical Area
D|MC5538420000000|Platteville, WI Micropolitan Statistical Area
D|MC5539960000000|Rice Lake, WI Micropolitan Statistical Area
D|MC5543020000000|Shawano, WI Micropolitan Statistical Area
D|MC5543890000000|Sparta, WI Micropolitan Statistical Area
D|MC5544620000000|Stevens Point-Plover, WI Micropolitan Statistical Area
D|MC5548020000000|Watertown-Fort Atkinson, WI Micropolitan Statistical Area
D|MC5548580000000|Whitewater-Elkhorn, WI Micropolitan Statistical Area
D|MC5549220000000|Wisconsin Rapids-Marshfield, WI Micropolitan Statistical Area
D|MC5617650000000|Cody, WY Micropolitan Statistical Area
D|MC5621740000000|Evanston, WY-UT Micropolitan Statistical Area
D|MC5623940000000|Gillette, WY Micropolitan Statistical Area
D|MC5627220000000|Jackson, WY-ID Micropolitan Statistical Area
D|MC5629660000000|Laramie, WY Micropolitan Statistical Area
D|MC5640180000000|Riverton, WY Micropolitan Statistical Area
D|MC5640540000000|Rock Springs, WY Micropolitan Statistical Area
D|MC5643260000000|Sheridan, WY Micropolitan Statistical Area
D|MC7217620000000|Coamo, PR Micropolitan Statistical Area
D|MC7217640000000|Coco, PR Micropolitan Statistical Area
D|MC7229720000000|Lares, PR Micropolitan Statistical Area
D|MC7246580000000|Utuado, PR Micropolitan Statistical Area
E|CA0114200000000|Birmingham-Cullman-Talladega, AL Combined Statistical Area
E|CA0119400000000|Columbus-Auburn-Opelika, GA-AL Combined Statistical Area
E|CA0122200000000|Dothan-Enterprise-Ozark, AL Combined Statistical Area
E|CA0125000000000|Florence-Muscle Shoals-Russellville, AL Combined Statistical Area
E|CA0129000000000|Huntsville-Decatur-Albertville, AL-TN Combined Statistical Area
E|CA0138000000000|Mobile-Daphne-Fairhope, AL Combined Statistical Area
E|CA0138800000000|Montgomery-Selma, AL Combined Statistical Area
E|CA0442900000000|Phoenix-Mesa, AZ Combined Statistical Area
E|CA0453600000000|Tucson-Nogales, AZ Combined Statistical Area
E|CA0528400000000|Hot Springs-Malvern, AR Combined Statistical Area
E|CA0530800000000|Jonesboro-Paragould, AR Combined Statistical Area
E|CA0534000000000|Little Rock-North Little Rock, AR Combined Statistical Area
E|CA0615200000000|Brookings-Crescent City, OR-CA Combined Statistical Area
E|CA0626000000000|Fresno-Hanford-Corcoran, CA Combined Statistical Area
E|CA0634800000000|Los Angeles-Long Beach, CA Combined Statistical Area
E|CA0645400000000|Redding-Red Bluff, CA Combined Statistical Area
E|CA0647200000000|Sacramento-Roseville, CA Combined Statistical Area
E|CA0648800000000|San Jose-San Francisco-Oakland, CA Combined Statistical Area
E|CA0821600000000|Denver-Aurora-Greeley, CO Combined Statistical Area
E|CA0823300000000|Edwards-Rifle, CO Combined Statistical Area
E|CA0844400000000|Pueblo-Canon City, CO Combined Statistical Area
E|CA0940500000000|New Haven-Hartford-Waterbury, CT Combined Statistical Area
E|CA1154800000000|Washington-Baltimore-Arlington, DC-MD-VA-WV-PA Combined Statistical Area
E|CA1216300000000|Cape Coral-Fort Myers-Naples, FL Combined Statistical Area
E|CA1226400000000|Gainesville-Lake City, FL Combined Statistical Area
E|CA1230000000000|Jacksonville-Kingsland-Palatka, FL-GA Combined Statistical Area
E|CA1237000000000|Miami-Port St. Lucie-Fort Lauderdale, FL Combined Statistical Area
E|CA1241200000000|North Port-Bradenton, FL Combined Statistical Area
E|CA1242200000000|Orlando-Lakeland-Deltona, FL Combined Statistical Area
E|CA1253300000000|Tallahassee-Bainbridge, FL-GA Combined Statistical Area
E|CA1312200000000|Atlanta--Athens-Clarke County--Sandy Springs, GA-AL Combined Statistical Area
E|CA1335600000000|Macon-Bibb County--Warner Robins, GA Combined Statistical Area
E|CA1349600000000|Savannah-Hinesville-Statesboro, GA Combined Statistical Area
E|CA1614700000000|Boise City-Mountain Home-Ontario, ID-OR Combined Statistical Area
E|CA1629200000000|Idaho Falls-Rexburg-Blackfoot, ID Combined Statistical Area
E|CA1714500000000|Bloomington-Pontiac, IL Combined Statistical Area
E|CA1716600000000|Carbondale-Marion-Herrin, IL Combined Statistical Area
E|CA1716900000000|Champaign-Urbana-Danville, IL Combined Statistical Area
E|CA1717600000000|Chicago-Naperville, IL-IN-WI Combined Statistical Area
E|CA1722100000000|Dixon-Sterling, IL Combined Statistical Area
E|CA1742700000000|Peoria-Canton, IL Combined Statistical Area
E|CA1744800000000|Quincy-Hannibal, IL-MO Combined Statistical Area
E|CA1746600000000|Rockford-Freeport-Rochelle, IL Combined Statistical Area
E|CA1752200000000|Springfield-Jacksonville-Lincoln, IL Combined Statistical Area
E|CA1814400000000|Bloomington-Bedford, IN Combined Statistical Area
E|CA1824100000000|Evansville-Henderson, IN-KY Combined Statistical Area
E|CA1825800000000|Fort Wayne-Huntington-Auburn, IN Combined Statistical Area
E|CA1829400000000|Indianapolis-Carmel-Muncie, IN Combined Statistical Area
E|CA1832000000000|Lafayette-West Lafayette-Frankfort, IN Combined Statistical Area
E|CA1845800000000|Richmond-Connersville, IN Combined Statistical Area
E|CA1851500000000|South Bend-Elkhart-Mishawaka, IN-MI Combined Statistical Area
E|CA1916100000000|Burlington-Fort Madison, IA-IL Combined Statistical Area
E|CA1916800000000|Cedar Rapids-Iowa City, IA Combined Statistical Area
E|CA1920900000000|Davenport-Moline, IA-IL Combined Statistical Area
E|CA1921800000000|Des Moines-West Des Moines-Ames, IA Combined Statistical Area
E|CA1951200000000|Sioux City-Le Mars, IA-NE-SD Combined Statistical Area
E|CA1951700000000|Spencer-Spirit Lake, IA Combined Statistical Area
E|CA2055600000000|Wichita-Arkansas City-Winfield, KS Combined Statistical Area
E|CA2115000000000|Bowling Green-Glasgow-Franklin, KY Combined Statistical Area
E|CA2133600000000|Lexington-Fayette--Richmond--Frankfort, KY Combined Statistical Area
E|CA2135000000000|Louisville/Jefferson County--Elizabethtown, KY-IN Combined Statistical Area
E|CA2137100000000|Middlesborough-Corbin, KY Combined Statistical Area
E|CA2142400000000|Paducah-Mayfield, KY-IL Combined Statistical Area
E|CA2213200000000|Baton Rouge-Hammond, LA Combined Statistical Area
E|CA2231800000000|Lafayette-New Iberia-Opelousas, LA Combined Statistical Area
E|CA2232400000000|Lake Charles-DeRidder, LA Combined Statistical Area
E|CA2238400000000|Monroe-Ruston, LA Combined Statistical Area
E|CA2240600000000|New Orleans-Metairie-Slidell, LA-MS Combined Statistical Area
E|CA2250800000000|Shreveport-Bossier City-Minden, LA Combined Statistical Area
E|CA2343800000000|Portland-Lewiston-South Portland, ME Combined Statistical Area
E|CA2448000000000|Salisbury-Ocean Pines, MD Combined Statistical Area
E|CA2514800000000|Boston-Worcester-Providence, MA-RI-NH Combined Statistical Area
E|CA2552100000000|Springfield-Amherst Town-Northampton, MA Combined Statistical Area
E|CA2622000000000|Detroit-Warren-Ann Arbor, MI Combined Statistical Area
E|CA2626600000000|Grand Rapids-Wyoming, MI Combined Statistical Area
E|CA2631000000000|Kalamazoo-Battle Creek-Portage, MI Combined Statistical Area
E|CA2633000000000|Lansing-East Lansing-Owosso, MI Combined Statistical Area
E|CA2636100000000|Marinette-Iron Mountain, WI-MI Combined Statistical Area
E|CA2639400000000|Mount Pleasant-Alma, MI Combined Statistical Area
E|CA2647400000000|Saginaw-Midland-Bay City, MI Combined Statistical Area
E|CA2722800000000|Duluth-Grand Rapids, MN-WI Combined Statistical Area
E|CA2735900000000|Mankato-New Ulm, MN Combined Statistical Area
E|CA2737800000000|Minneapolis-St. Paul, MN-WI Combined Statistical Area
E|CA2746200000000|Rochester-Austin-Winona, MN Combined Statistical Area
E|CA2827900000000|Hattiesburg-Laurel, MS Combined Statistical Area
E|CA2829800000000|Jackson-Vicksburg-Brookhaven, MS Combined Statistical Area
E|CA2852300000000|Starkville-Columbus, MS Combined Statistical Area
E|CA2853900000000|Tupelo-Corinth, MS Combined Statistical Area
E|CA2916400000000|Cape Girardeau-Sikeston, MO-IL Combined Statistical Area
E|CA2919000000000|Columbia-Jefferson City-Moberly, MO Combined Statistical Area
E|CA2930900000000|Joplin-Miami, MO-OK-KS Combined Statistical Area
E|CA2931200000000|Kansas City-Overland Park-Kansas City, MO-KS Combined Statistical Area
E|CA2947600000000|St. Louis-St. Charles-Farmington, MO-IL Combined Statistical Area
E|CA3133900000000|Lincoln-Beatrice, NE Combined Statistical Area
E|CA3142000000000|Omaha-Fremont, NE-IA Combined Statistical Area
E|CA3233200000000|Las Vegas-Henderson, NV Combined Statistical Area
E|CA3245600000000|Reno-Carson City-Gardnerville Ranchos, NV-CA Combined Statistical Area
E|CA3331300000000|Keene-Brattleboro, NH-VT Combined Statistical Area
E|CA3510500000000|Albuquerque-Santa Fe-Los Alamos, NM Combined Statistical Area
E|CA3610400000000|Albany-Schenectady, NY Combined Statistical Area
E|CA3616000000000|Buffalo-Cheektowaga-Olean, NY Combined Statistical Area
E|CA3623600000000|Elmira-Corning, NY Combined Statistical Area
E|CA3629600000000|Ithaca-Cortland, NY Combined Statistical Area
E|CA3640800000000|New York-Newark, NY-NJ-CT-PA Combined Statistical Area
E|CA3646400000000|Rochester-Batavia-Seneca Falls, NY Combined Statistical Area
E|CA3653200000000|Syracuse-Auburn, NY Combined Statistical Area
E|CA3712000000000|Asheville-Waynesville-Brevard, NC Combined Statistical Area
E|CA3717200000000|Charlotte-Concord, NC-SC Combined Statistical Area
E|CA3724600000000|Fayetteville-Lumberton-Pinehurst, NC Combined Statistical Area
E|CA3726800000000|Greensboro--Winston-Salem--High Point, NC Combined Statistical Area
E|CA3727400000000|Greenville-Washington, NC Combined Statistical Area
E|CA3740400000000|New Bern-Morehead City, NC Combined Statistical Area
E|CA3745000000000|Raleigh-Durham-Cary, NC Combined Statistical Area
E|CA3746800000000|Rocky Mount-Wilson-Roanoke Rapids, NC Combined Statistical Area
E|CA3824400000000|Fargo-Wahpeton, ND-MN Combined Statistical Area
E|CA3917800000000|Cincinnati-Wilmington, OH-KY-IN Combined Statistical Area
E|CA3918400000000|Cleveland-Akron-Canton, OH Combined Statistical Area
E|CA3919800000000|Columbus-Marion-Zanesville, OH Combined Statistical Area
E|CA3921200000000|Dayton-Springfield-Kettering, OH Combined Statistical Area
E|CA3924800000000|Findlay-Tiffin, OH Combined Statistical Area
E|CA3933800000000|Lima-Van Wert-Celina, OH Combined Statistical Area
E|CA3936000000000|Mansfield-Ashland-Bucyrus, OH Combined Statistical Area
E|CA3956600000000|Youngstown-Warren-Salem, OH Combined Statistical Area
E|CA4033400000000|Lawton-Duncan, OK Combined Statistical Area
E|CA4041600000000|Oklahoma City-Shawnee, OK Combined Statistical Area
E|CA4053800000000|Tulsa-Bartlesville-Muskogee, OK Combined Statistical Area
E|CA4055500000000|Weatherford-Elk City, OK Combined Statistical Area
E|CA4136600000000|Medford-Grants Pass, OR Combined Statistical Area
E|CA4144000000000|Portland-Vancouver-Salem, OR-WA Combined Statistical Area
E|CA4210600000000|Allentown-Bethlehem-East Stroudsburg, PA-NJ Combined Statistical Area
E|CA4210700000000|Altoona-Huntingdon, PA Combined Statistical Area
E|CA4214600000000|Bloomsburg-Berwick-Sunbury, PA Combined Statistical Area
E|CA4224000000000|Erie-Meadville, PA Combined Statistical Area
E|CA4227600000000|Harrisburg-York-Lebanon, PA Combined Statistical Area
E|CA4230600000000|Johnstown-Somerset, PA Combined Statistical Area
E|CA4242800000000|Philadelphia-Reading-Camden, PA-NJ-DE-MD Combined Statistical Area
E|CA4243000000000|Pittsburgh-Weirton-Steubenville, PA-OH-WV Combined Statistical Area
E|CA4252400000000|State College-DuBois, PA Combined Statistical Area
E|CA4255800000000|Williamsport-Lock Haven, PA Combined Statistical Area
E|CA4519200000000|Columbia-Sumter-Orangeburg, SC Combined Statistical Area
E|CA4527300000000|Greenville-Spartanburg-Anderson, SC Combined Statistical Area
E|CA4539600000000|Myrtle Beach-Conway, SC Combined Statistical Area
E|CA4645200000000|Rapid City-Spearfish, SD Combined Statistical Area
E|CA4717400000000|Chattanooga-Cleveland-Dalton, TN-GA-AL Combined Statistical Area
E|CA4730400000000|Johnson City-Kingsport-Bristol, TN-VA Combined Statistical Area
E|CA4731500000000|Knoxville-Morristown-Sevierville, TN Combined Statistical Area
E|CA4736800000000|Memphis-Clarksdale-Forrest City, TN-MS-AR Combined Statistical Area
E|CA4740000000000|Nashville-Davidson--Murfreesboro, TN Combined Statistical Area
E|CA4754200000000|Union City-Martin, TN Combined Statistical Area
E|CA4810100000000|Abilene-Sweetwater, TX Combined Statistical Area
E|CA4810800000000|Amarillo-Borger, TX Combined Statistical Area
E|CA4815400000000|Brownsville-Harlingen-Raymondville, TX Combined Statistical Area
E|CA4820400000000|Corpus Christi-Kingsville-Alice, TX Combined Statistical Area
E|CA4820600000000|Dallas-Fort Worth, TX-OK Combined Statistical Area
E|CA4823800000000|El Paso-Las Cruces, TX-NM Combined Statistical Area
E|CA4828800000000|Houston-Pasadena, TX Combined Statistical Area
E|CA4835200000000|Lubbock-Plainview, TX Combined Statistical Area
E|CA4836500000000|McAllen-Edinburg, TX Combined Statistical Area
E|CA4837200000000|Midland-Odessa-Andrews, TX Combined Statistical Area
E|CA4848400000000|San Antonio-New Braunfels-Kerrville, TX Combined Statistical Area
E|CA4854000000000|Tyler-Jacksonville, TX Combined Statistical Area
E|CA4854400000000|Victoria-Port Lavaca, TX Combined Statistical Area
E|CA4948200000000|Salt Lake City-Provo-Orem, UT-ID Combined Statistical Area
E|CA5016200000000|Burlington-South Burlington-Barre, VT Combined Statistical Area
E|CA5127700000000|Harrisonburg-Staunton-Stuarts Draft, VA Combined Statistical Area
E|CA5154500000000|Virginia Beach-Chesapeake, VA-NC Combined Statistical Area
E|CA5331400000000|Kennewick-Richland-Walla Walla, WA Combined Statistical Area
E|CA5339300000000|Moses Lake-Othello, WA Combined Statistical Area
E|CA5344600000000|Pullman-Moscow, WA-ID Combined Statistical Area
E|CA5350000000000|Seattle-Tacoma, WA Combined Statistical Area
E|CA5351800000000|Spokane-Spokane Valley-Coeur d'Alene, WA-ID Combined Statistical Area
E|CA5417000000000|Charleston-Huntington-Ashland, WV-OH-KY Combined Statistical Area
E|CA5424200000000|Fairmont-Clarksburg, WV Combined Statistical Area
E|CA5442500000000|Parkersburg-Marietta-Vienna, WV-OH Combined Statistical Area
E|CA5511800000000|Appleton-Oshkosh-Neenah, WI Combined Statistical Area
E|CA5523200000000|Eau Claire-Menomonie, WI Combined Statistical Area
E|CA5526700000000|Green Bay-Shawano, WI Combined Statistical Area
E|CA5531700000000|La Crosse-Onalaska-Sparta, WI-MN Combined Statistical Area
E|CA5535700000000|Madison-Janesville-Beloit, WI Combined Statistical Area
E|CA5537600000000|Milwaukee-Racine-Waukesha, WI Combined Statistical Area
E|CA5555400000000|Wausau-Stevens Point-Wisconsin Rapids, WI Combined Statistical Area
E|CA7236400000000|Mayaguez-Aguadilla, PR Combined Statistical Area
E|CA7243400000000|Ponce-Coamo, PR Combined Statistical Area
E|CA7249000000000|San Juan-Bayamon, PR Combined Statistical Area
F|CN0100100000000|Autauga County, AL
F|CN0100300000000|Baldwin County, AL
F|CN0100500000000|Barbour County, AL
F|CN0100700000000|Bibb County, AL
F|CN0100900000000|Blount County, AL
F|CN0101100000000|Bullock County, AL
F|CN0101300000000|Butler County, AL
F|CN0101500000000|Calhoun County, AL
F|CN0101700000000|Chambers County, AL
F|CN0101900000000|Cherokee County, AL
F|CN0102100000000|Chilton County, AL
F|CN0102300000000|Choctaw County, AL
F|CN0102500000000|Clarke County, AL
F|CN0102700000000|Clay County, AL
F|CN0102900000000|Cleburne County, AL
F|CN0103100000000|Coffee County, AL
F|CN0103300000000|Colbert County, AL
F|CN0103500000000|Conecuh County, AL
F|CN0103700000000|Coosa County, AL
F|CN0103900000000|Covington County, AL
F|CN0104100000000|Crenshaw County, AL
F|CN0104300000000|Cullman County, AL
F|CN0104500000000|Dale County, AL
F|CN0104700000000|Dallas County, AL
F|CN0104900000000|DeKalb County, AL
F|CN0105100000000|Elmore County, AL
F|CN0105300000000|Escambia County, AL
F|CN0105500000000|Etowah County, AL
F|CN0105700000000|Fayette County, AL
F|CN0105900000000|Franklin County, AL
F|CN0106100000000|Geneva County, AL
F|CN0106300000000|Greene County, AL
F|CN0106500000000|Hale County, AL
F|CN0106700000000|Henry County, AL
F|CN0106900000000|Houston County, AL
F|CN0107100000000|Jackson County, AL
F|CN0107300000000|Jefferson County, AL
F|CN0107500000000|Lamar County, AL
F|CN0107700000000|Lauderdale County, AL
F|CN0107900000000|Lawrence County, AL
F|CN0108100000000|Lee County, AL
F|CN0108300000000|Limestone County, AL
F|CN0108500000000|Lowndes County, AL
F|CN0108700000000|Macon County, AL
F|CN0108900000000|Madison County, AL
F|CN0109100000000|Marengo County, AL
F|CN0109300000000|Marion County, AL
F|CN0109500000000|Marshall County, AL
F|CN0109700000000|Mobile County, AL
F|CN0109900000000|Monroe County, AL
F|CN0110100000000|Montgomery County, AL
F|CN0110300000000|Morgan County, AL
F|CN0110500000000|Perry County, AL
F|CN0110700000000|Pickens County, AL
F|CN0110900000000|Pike County, AL
F|CN0111100000000|Randolph County, AL
F|CN0111300000000|Russell County, AL
F|CN0111500000000|St. Clair County, AL
F|CN0111700000000|Shelby County, AL
F|CN0111900000000|Sumter County, AL
F|CN0112100000000|Talladega County, AL
F|CN0112300000000|Tallapoosa County, AL
F|CN0112500000000|Tuscaloosa County, AL
F|CN0112700000000|Walker County, AL
F|CN0112900000000|Washington County, AL
F|CN0113100000000|Wilcox County, AL
F|CN0113300000000|Winston County, AL
F|CN0201300000000|Aleutians East Borough, AK
F|CN0201600000000|Aleutians West Census Area, AK
F|CN0202000000000|Anchorage Borough/municipality, AK
F|CN0205000000000|Bethel Census Area, AK
F|CN0206000000000|Bristol Bay Borough, AK
F|CN0206300000000|Chugach Census Area, AK
F|CN0206600000000|Copper River Census Area, AK
F|CN0206800000000|Denali Borough, AK
F|CN0207000000000|Dillingham Census Area, AK
F|CN0209000000000|Fairbanks North Star Borough, AK
F|CN0210000000000|Haines Borough, AK
F|CN0210500000000|Hoonah-Angoon Census Area, AK
F|CN0211000000000|Juneau Borough/city, AK
F|CN0212200000000|Kenai Peninsula Borough, AK
F|CN0213000000000|Ketchikan Gateway Borough, AK
F|CN0215000000000|Kodiak Island Borough, AK
F|CN0215800000000|Kusilvak Census Area, AK
F|CN0216400000000|Lake and Peninsula Borough, AK
F|CN0217000000000|Matanuska-Susitna Borough, AK
F|CN0218000000000|Nome Census Area, AK
F|CN0218500000000|North Slope Borough, AK
F|CN0218800000000|Northwest Arctic Borough, AK
F|CN0219500000000|Petersburg Borough, AK
F|CN0219800000000|Prince of Wales-Hyder Census Area, AK
F|CN0220100000000|Prince of Wales-Outer Ketchikan Census Area, AK
F|CN0222000000000|Sitka Borough/city, AK
F|CN0223000000000|Skagway Municipality, AK
F|CN0223200000000|Skagway-Hoonah-Angoon Census Area, AK
F|CN0224000000000|Southeast Fairbanks Census Area, AK
F|CN0226100000000|Valdez-Cordova Census Area, AK
F|CN0227500000000|Wrangell Borough/city, AK
F|CN0228000000000|Wrangell-Petersburg Census Area, AK
F|CN0228200000000|Yakutat Borough/city, AK
F|CN0229000000000|Yukon-Koyukuk Census Area, AK
F|CN0400100000000|Apache County, AZ
F|CN0400300000000|Cochise County, AZ
F|CN0400500000000|Coconino County, AZ
F|CN0400700000000|Gila County, AZ
F|CN0400900000000|Graham County, AZ
F|CN0401100000000|Greenlee County, AZ
F|CN0401200000000|La Paz County, AZ
F|CN0401300000000|Maricopa County, AZ
F|CN0401500000000|Mohave County, AZ
F|CN0401700000000|Navajo County, AZ
F|CN0401900000000|Pima County, AZ
F|CN0402100000000|Pinal County, AZ
F|CN0402300000000|Santa Cruz County, AZ
F|CN0402500000000|Yavapai County, AZ
F|CN0402700000000|Yuma County, AZ
F|CN0500100000000|Arkansas County, AR
F|CN0500300000000|Ashley County, AR
F|CN0500500000000|Baxter County, AR
F|CN0500700000000|Benton County, AR
F|CN0500900000000|Boone County, AR
F|CN0501100000000|Bradley County, AR
F|CN0501300000000|Calhoun County, AR
F|CN0501500000000|Carroll County, AR
F|CN0501700000000|Chicot County, AR
F|CN0501900000000|Clark County, AR
F|CN0502100000000|Clay County, AR
F|CN0502300000000|Cleburne County, AR
F|CN0502500000000|Cleveland County, AR
F|CN0502700000000|Columbia County, AR
F|CN0502900000000|Conway County, AR
F|CN0503100000000|Craighead County, AR
F|CN0503300000000|Crawford County, AR
F|CN0503500000000|Crittenden County, AR
F|CN0503700000000|Cross County, AR
F|CN0503900000000|Dallas County, AR
F|CN0504100000000|Desha County, AR
F|CN0504300000000|Drew County, AR
F|CN0504500000000|Faulkner County, AR
F|CN0504700000000|Franklin County, AR
F|CN0504900000000|Fulton County, AR
F|CN0505100000000|Garland County, AR
F|CN0505300000000|Grant County, AR
F|CN0505500000000|Greene County, AR
F|CN0505700000000|Hempstead County, AR
F|CN0505900000000|Hot Spring County, AR
F|CN0506100000000|Howard County, AR
F|CN0506300000000|Independence County, AR
F|CN0506500000000|Izard County, AR
F|CN0506700000000|Jackson County, AR
F|CN0506900000000|Jefferson County, AR
F|CN0507100000000|Johnson County, AR
F|CN0507300000000|Lafayette County, AR
F|CN0507500000000|Lawrence County, AR
F|CN0507700000000|Lee County, AR
F|CN0507900000000|Lincoln County, AR
F|CN0508100000000|Little River County, AR
F|CN0508300000000|Logan County, AR
F|CN0508500000000|Lonoke County, AR
F|CN0508700000000|Madison County, AR
F|CN0508900000000|Marion County, AR
F|CN0509100000000|Miller County, AR
F|CN0509300000000|Mississippi County, AR
F|CN0509500000000|Monroe County, AR
F|CN0509700000000|Montgomery County, AR
F|CN0509900000000|Nevada County, AR
F|CN0510100000000|Newton County, AR
F|CN0510300000000|Ouachita County, AR
F|CN0510500000000|Perry County, AR
F|CN0510700000000|Phillips County, AR
F|CN0510900000000|Pike County, AR
F|CN0511100000000|Poinsett County, AR
F|CN0511300000000|Polk County, AR
F|CN0511500000000|Pope County, AR
F|CN0511700000000|Prairie County, AR
F|CN0511900000000|Pulaski County, AR
F|CN0512100000000|Randolph County, AR
F|CN0512300000000|St. Francis County, AR
F|CN0512500000000|Saline County, AR
F|CN0512700000000|Scott County, AR
F|CN0512900000000|Searcy County, AR
F|CN0513100000000|Sebastian County, AR
F|CN0513300000000|Sevier County, AR
F|CN0513500000000|Sharp County, AR
F|CN0513700000000|Stone County, AR
F|CN0513900000000|Union County, AR
F|CN0514100000000|Van Buren County, AR
F|CN0514300000000|Washington County, AR
F|CN0514500000000|White County, AR
F|CN0514700000000|Woodruff County, AR
F|CN0514900000000|Yell County, AR
F|CN0600100000000|Alameda County, CA
F|CN0600300000000|Alpine County, CA
F|CN0600500000000|Amador County, CA
F|CN0600700000000|Butte County, CA
F|CN0600900000000|Calaveras County, CA
F|CN0601100000000|Colusa County, CA
F|CN0601300000000|Contra Costa County, CA
F|CN0601500000000|Del Norte County, CA
F|CN0601700000000|El Dorado County, CA
F|CN0601900000000|Fresno County, CA
F|CN0602100000000|Glenn County, CA
F|CN0602300000000|Humboldt County, CA
F|CN0602500000000|Imperial County, CA
F|CN0602700000000|Inyo County, CA
F|CN0602900000000|Kern County, CA
F|CN0603100000000|Kings County, CA
F|CN0603300000000|Lake County, CA
F|CN0603500000000|Lassen County, CA
F|CN0603700000000|Los Angeles County, CA
F|CN0603900000000|Madera County, CA
F|CN0604100000000|Marin County, CA
F|CN0604300000000|Mariposa County, CA
F|CN0604500000000|Mendocino County, CA
F|CN0604700000000|Merced County, CA
F|CN0604900000000|Modoc County, CA
F|CN0605100000000|Mono County, CA
F|CN0605300000000|Monterey County, CA
F|CN0605500000000|Napa County, CA
F|CN0605700000000|Nevada County, CA
F|CN0605900000000|Orange County, CA
F|CN0606100000000|Placer County, CA
F|CN0606300000000|Plumas County, CA
F|CN0606500000000|Riverside County, CA
F|CN0606700000000|Sacramento County, CA
F|CN0606900000000|San Benito County, CA
F|CN0607100000000|San Bernardino County, CA
F|CN0607300000000|San Diego County, CA
F|CN0607500000000|San Francisco County/city, CA
F|CN0607700000000|San Joaquin County, CA
F|CN0607900000000|San Luis Obispo County, CA
F|CN0608100000000|San Mateo County, CA
F|CN0608300000000|Santa Barbara County, CA
F|CN0608500000000|Santa Clara County, CA
F|CN0608700000000|Santa Cruz County, CA
F|CN0608900000000|Shasta County, CA
F|CN0609100000000|Sierra County, CA
F|CN0609300000000|Siskiyou County, CA
F|CN0609500000000|Solano County, CA
F|CN0609700000000|Sonoma County, CA
F|CN0609900000000|Stanislaus County, CA
F|CN0610100000000|Sutter County, CA
F|CN0610300000000|Tehama County, CA
F|CN0610500000000|Trinity County, CA
F|CN0610700000000|Tulare County, CA
F|CN0610900000000|Tuolumne County, CA
F|CN0611100000000|Ventura County, CA
F|CN0611300000000|Yolo County, CA
F|CN0611500000000|Yuba County, CA
F|CN0800100000000|Adams County, CO
F|CN0800300000000|Alamosa County, CO
F|CN0800500000000|Arapahoe County, CO
F|CN0800700000000|Archuleta County, CO
F|CN0800900000000|Baca County, CO
F|CN0801100000000|Bent County, CO
F|CN0801300000000|Boulder County, CO
F|CN0801400000000|Broomfield County/city, CO
F|CN0801500000000|Chaffee County, CO
F|CN0801700000000|Cheyenne County, CO
F|CN0801900000000|Clear Creek County, CO
F|CN0802100000000|Conejos County, CO
F|CN0802300000000|Costilla County, CO
F|CN0802500000000|Crowley County, CO
F|CN0802700000000|Custer County, CO
F|CN0802900000000|Delta County, CO
F|CN0803100000000|Denver County/city, CO
F|CN0803300000000|Dolores County, CO
F|CN0803500000000|Douglas County, CO
F|CN0803700000000|Eagle County, CO
F|CN0803900000000|Elbert County, CO
F|CN0804100000000|El Paso County, CO
F|CN0804300000000|Fremont County, CO
F|CN0804500000000|Garfield County, CO
F|CN0804700000000|Gilpin County, CO
F|CN0804900000000|Grand County, CO
F|CN0805100000000|Gunnison County, CO
F|CN0805300000000|Hinsdale County, CO
F|CN0805500000000|Huerfano County, CO
F|CN0805700000000|Jackson County, CO
F|CN0805900000000|Jefferson County, CO
F|CN0806100000000|Kiowa County, CO
F|CN0806300000000|Kit Carson County, CO
F|CN0806500000000|Lake County, CO
F|CN0806700000000|La Plata County, CO
F|CN0806900000000|Larimer County, CO
F|CN0807100000000|Las Animas County, CO
F|CN0807300000000|Lincoln County, CO
F|CN0807500000000|Logan County, CO
F|CN0807700000000|Mesa County, CO
F|CN0807900000000|Mineral County, CO
F|CN0808100000000|Moffat County, CO
F|CN0808300000000|Montezuma County, CO
F|CN0808500000000|Montrose County, CO
F|CN0808700000000|Morgan County, CO
F|CN0808900000000|Otero County, CO
F|CN0809100000000|Ouray County, CO
F|CN0809300000000|Park County, CO
F|CN0809500000000|Phillips County, CO
F|CN0809700000000|Pitkin County, CO
F|CN0809900000000|Prowers County, CO
F|CN0810100000000|Pueblo County, CO
F|CN0810300000000|Rio Blanco County, CO
F|CN0810500000000|Rio Grande County, CO
F|CN0810700000000|Routt County, CO
F|CN0810900000000|Saguache County, CO
F|CN0811100000000|San Juan County, CO
F|CN0811300000000|San Miguel County, CO
F|CN0811500000000|Sedgwick County, CO
F|CN0811700000000|Summit County, CO
F|CN0811900000000|Teller County, CO
F|CN0812100000000|Washington County, CO
F|CN0812300000000|Weld County, CO
F|CN0812500000000|Yuma County, CO
F|CN0911000000000|Capitol Planning Region, CT
F|CN0912000000000|Greater Bridgeport Planning Region, CT
F|CN0913000000000|Lower Connecticut River Valley Planning Region, CT
F|CN0914000000000|Naugatuck Valley Planning Region, CT
F|CN0915000000000|Northeastern Connecticut Planning Region, CT
F|CN0916000000000|Northwest Hills Planning Region, CT
F|CN0917000000000|South Central Connecticut Planning Region, CT
F|CN0918000000000|Southeastern Connecticut Planning Region, CT
F|CN0919000000000|Western Connecticut Planning Region, CT
F|CN1000100000000|Kent County, DE
F|CN1000300000000|New Castle County, DE
F|CN1000500000000|Sussex County, DE
F|CN1100100000000|District of Columbia
F|CN1200100000000|Alachua County, FL
F|CN1200300000000|Baker County, FL
F|CN1200500000000|Bay County, FL
F|CN1200700000000|Bradford County, FL
F|CN1200900000000|Brevard County, FL
F|CN1201100000000|Broward County, FL
F|CN1201300000000|Calhoun County, FL
F|CN1201500000000|Charlotte County, FL
F|CN1201700000000|Citrus County, FL
F|CN1201900000000|Clay County, FL
F|CN1202100000000|Collier County, FL
F|CN1202300000000|Columbia County, FL
F|CN1202700000000|DeSoto County, FL
F|CN1202900000000|Dixie County, FL
F|CN1203100000000|Duval County, FL
F|CN1203300000000|Escambia County, FL
F|CN1203500000000|Flagler County, FL
F|CN1203700000000|Franklin County, FL
F|CN1203900000000|Gadsden County, FL
F|CN1204100000000|Gilchrist County, FL
F|CN1204300000000|Glades County, FL
F|CN1204500000000|Gulf County, FL
F|CN1204700000000|Hamilton County, FL
F|CN1204900000000|Hardee County, FL
F|CN1205100000000|Hendry County, FL
F|CN1205300000000|Hernando County, FL
F|CN1205500000000|Highlands County, FL
F|CN1205700000000|Hillsborough County, FL
F|CN1205900000000|Holmes County, FL
F|CN1206100000000|Indian River County, FL
F|CN1206300000000|Jackson County, FL
F|CN1206500000000|Jefferson County, FL
F|CN1206700000000|Lafayette County, FL
F|CN1206900000000|Lake County, FL
F|CN1207100000000|Lee County, FL
F|CN1207300000000|Leon County, FL
F|CN1207500000000|Levy County, FL
F|CN1207700000000|Liberty County, FL
F|CN1207900000000|Madison County, FL
F|CN1208100000000|Manatee County, FL
F|CN1208300000000|Marion County, FL
F|CN1208500000000|Martin County, FL
F|CN1208600000000|Miami-Dade County, FL
F|CN1208700000000|Monroe County, FL
F|CN1208900000000|Nassau County, FL
F|CN1209100000000|Okaloosa County, FL
F|CN1209300000000|Okeechobee County, FL
F|CN1209500000000|Orange County, FL
F|CN1209700000000|Osceola County, FL
F|CN1209900000000|Palm Beach County, FL
F|CN1210100000000|Pasco County, FL
F|CN1210300000000|Pinellas County, FL
F|CN1210500000000|Polk County, FL
F|CN1210700000000|Putnam County, FL
F|CN1210900000000|St. Johns County, FL
F|CN1211100000000|St. Lucie County, FL
F|CN1211300000000|Santa Rosa County, FL
F|CN1211500000000|Sarasota County, FL
F|CN1211700000000|Seminole County, FL
F|CN1211900000000|Sumter County, FL
F|CN1212100000000|Suwannee County, FL
F|CN1212300000000|Taylor County, FL
F|CN1212500000000|Union County, FL
F|CN1212700000000|Volusia County, FL
F|CN1212900000000|Wakulla County, FL
F|CN1213100000000|Walton County, FL
F|CN1213300000000|Washington County, FL
F|CN1300100000000|Appling County, GA
F|CN1300300000000|Atkinson County, GA
F|CN1300500000000|Bacon County, GA
F|CN1300700000000|Baker County, GA
F|CN1300900000000|Baldwin County, GA
F|CN1301100000000|Banks County, GA
F|CN1301300000000|Barrow County, GA
F|CN1301500000000|Bartow County, GA
F|CN1301700000000|Ben Hill County, GA
F|CN1301900000000|Berrien County, GA
F|CN1302100000000|Bibb County, GA
F|CN1302300000000|Bleckley County, GA
F|CN1302500000000|Brantley County, GA
F|CN1302700000000|Brooks County, GA
F|CN1302900000000|Bryan County, GA
F|CN1303100000000|Bulloch County, GA
F|CN1303300000000|Burke County, GA
F|CN1303500000000|Butts County, GA
F|CN1303700000000|Calhoun County, GA
F|CN1303900000000|Camden County, GA
F|CN1304300000000|Candler County, GA
F|CN1304500000000|Carroll County, GA
F|CN1304700000000|Catoosa County, GA
F|CN1304900000000|Charlton County, GA
F|CN1305100000000|Chatham County, GA
F|CN1305300000000|Chattahoochee County, GA
F|CN1305500000000|Chattooga County, GA
F|CN1305700000000|Cherokee County, GA
F|CN1305900000000|Clarke County, GA
F|CN1306100000000|Clay County, GA
F|CN1306300000000|Clayton County, GA
F|CN1306500000000|Clinch County, GA
F|CN1306700000000|Cobb County, GA
F|CN1306900000000|Coffee County, GA
F|CN1307100000000|Colquitt County, GA
F|CN1307300000000|Columbia County, GA
F|CN1307500000000|Cook County, GA
F|CN1307700000000|Coweta County, GA
F|CN1307900000000|Crawford County, GA
F|CN1308100000000|Crisp County, GA
F|CN1308300000000|Dade County, GA
F|CN1308500000000|Dawson County, GA
F|CN1308700000000|Decatur County, GA
F|CN1308900000000|DeKalb County, GA
F|CN1309100000000|Dodge County, GA
F|CN1309300000000|Dooly County, GA
F|CN1309500000000|Dougherty County, GA
F|CN1309700000000|Douglas County, GA
F|CN1309900000000|Early County, GA
F|CN1310100000000|Echols County, GA
F|CN1310300000000|Effingham County, GA
F|CN1310500000000|Elbert County, GA
F|CN1310700000000|Emanuel County, GA
F|CN1310900000000|Evans County, GA
F|CN1311100000000|Fannin County, GA
F|CN1311300000000|Fayette County, GA
F|CN1311500000000|Floyd County, GA
F|CN1311700000000|Forsyth County, GA
F|CN1311900000000|Franklin County, GA
F|CN1312100000000|Fulton County, GA
F|CN1312300000000|Gilmer County, GA
F|CN1312500000000|Glascock County, GA
F|CN1312700000000|Glynn County, GA
F|CN1312900000000|Gordon County, GA
F|CN1313100000000|Grady County, GA
F|CN1313300000000|Greene County, GA
F|CN1313500000000|Gwinnett County, GA
F|CN1313700000000|Habersham County, GA
F|CN1313900000000|Hall County, GA
F|CN1314100000000|Hancock County, GA
F|CN1314300000000|Haralson County, GA
F|CN1314500000000|Harris County, GA
F|CN1314700000000|Hart County, GA
F|CN1314900000000|Heard County, GA
F|CN1315100000000|Henry County, GA
F|CN1315300000000|Houston County, GA
F|CN1315500000000|Irwin County, GA
F|CN1315700000000|Jackson County, GA
F|CN1315900000000|Jasper County, GA
F|CN1316100000000|Jeff Davis County, GA
F|CN1316300000000|Jefferson County, GA
F|CN1316500000000|Jenkins County, GA
F|CN1316700000000|Johnson County, GA
F|CN1316900000000|Jones County, GA
F|CN1317100000000|Lamar County, GA
F|CN1317300000000|Lanier County, GA
F|CN1317500000000|Laurens County, GA
F|CN1317700000000|Lee County, GA
F|CN1317900000000|Liberty County, GA
F|CN1318100000000|Lincoln County, GA
F|CN1318300000000|Long County, GA
F|CN1318500000000|Lowndes County, GA
F|CN1318700000000|Lumpkin County, GA
F|CN1318900000000|McDuffie County, GA
F|CN1319100000000|McIntosh County, GA
F|CN1319300000000|Macon County, GA
F|CN1319500000000|Madison County, GA
F|CN1319700000000|Marion County, GA
F|CN1319900000000|Meriwether County, GA
F|CN1320100000000|Miller County, GA
F|CN1320500000000|Mitchell County, GA
F|CN1320700000000|Monroe County, GA
F|CN1320900000000|Montgomery County, GA
F|CN1321100000000|Morgan County, GA
F|CN1321300000000|Murray County, GA
F|CN1321500000000|Muscogee County, GA
F|CN1321700000000|Newton County, GA
F|CN1321900000000|Oconee County, GA
F|CN1322100000000|Oglethorpe County, GA
F|CN1322300000000|Paulding County, GA
F|CN1322500000000|Peach County, GA
F|CN1322700000000|Pickens County, GA
F|CN1322900000000|Pierce County, GA
F|CN1323100000000|Pike County, GA
F|CN1323300000000|Polk County, GA
F|CN1323500000000|Pulaski County, GA
F|CN1323700000000|Putnam County, GA
F|CN1323900000000|Quitman County, GA
F|CN1324100000000|Rabun County, GA
F|CN1324300000000|Randolph County, GA
F|CN1324500000000|Richmond County, GA
F|CN1324700000000|Rockdale County, GA
F|CN1324900000000|Schley County, GA
F|CN1325100000000|Screven County, GA
F|CN1325300000000|Seminole County, GA
F|CN1325500000000|Spalding County, GA
F|CN1325700000000|Stephens County, GA
F|CN1325900000000|Stewart County, GA
F|CN1326100000000|Sumter County, GA
F|CN1326300000000|Talbot County, GA
F|CN1326500000000|Taliaferro County, GA
F|CN1326700000000|Tattnall County, GA
F|CN1326900000000|Taylor County, GA
F|CN1327100000000|Telfair County, GA
F|CN1327300000000|Terrell County, GA
F|CN1327500000000|Thomas County, GA
F|CN1327700000000|Tift County, GA
F|CN1327900000000|Toombs County, GA
F|CN1328100000000|Towns County, GA
F|CN1328300000000|Treutlen County, GA
F|CN1328500000000|Troup County, GA
F|CN1328700000000|Turner County, GA
F|CN1328900000000|Twiggs County, GA
F|CN1329100000000|Union County, GA
F|CN1329300000000|Upson County, GA
F|CN1329500000000|Walker County, GA
F|CN1329700000000|Walton County, GA
F|CN1329900000000|Ware County, GA
F|CN1330100000000|Warren County, GA
F|CN1330300000000|Washington County, GA
F|CN1330500000000|Wayne County, GA
F|CN1330700000000|Webster County, GA
F|CN1330900000000|Wheeler County, GA
F|CN1331100000000|White County, GA
F|CN1331300000000|Whitfield County, GA
F|CN1331500000000|Wilcox County, GA
F|CN1331700000000|Wilkes County, GA
F|CN1331900000000|Wilkinson County, GA
F|CN1332100000000|Worth County, GA
F|CN1500100000000|Hawaii County, HI
F|CN1500300000000|Honolulu County/city, HI
F|CN1500700000000|Kauai County, HI
F|CN1500900000000|Maui County, HI
F|CN1600100000000|Ada County, ID
F|CN1600300000000|Adams County, ID
F|CN1600500000000|Bannock County, ID
F|CN1600700000000|Bear Lake County, ID
F|CN1600900000000|Benewah County, ID
F|CN1601100000000|Bingham County, ID
F|CN1601300000000|Blaine County, ID
F|CN1601500000000|Boise County, ID
F|CN1601700000000|Bonner County, ID
F|CN1601900000000|Bonneville County, ID
F|CN1602100000000|Boundary County, ID
F|CN1602300000000|Butte County, ID
F|CN1602500000000|Camas County, ID
F|CN1602700000000|Canyon County, ID
F|CN1602900000000|Caribou County, ID
F|CN1603100000000|Cassia County, ID
F|CN1603300000000|Clark County, ID
F|CN1603500000000|Clearwater County, ID
F|CN1603700000000|Custer County, ID
F|CN1603900000000|Elmore County, ID
F|CN1604100000000|Franklin County, ID
F|CN1604300000000|Fremont County, ID
F|CN1604500000000|Gem County, ID
F|CN1604700000000|Gooding County, ID
F|CN1604900000000|Idaho County, ID
F|CN1605100000000|Jefferson County, ID
F|CN1605300000000|Jerome County, ID
F|CN1605500000000|Kootenai County, ID
F|CN1605700000000|Latah County, ID
F|CN1605900000000|Lemhi County, ID
F|CN1606100000000|Lewis County, ID
F|CN1606300000000|Lincoln County, ID
F|CN1606500000000|Madison County, ID
F|CN1606700000000|Minidoka County, ID
F|CN1606900000000|Nez Perce County, ID
F|CN1607100000000|Oneida County, ID
F|CN1607300000000|Owyhee County, ID
F|CN1607500000000|Payette County, ID
F|CN1607700000000|Power County, ID
F|CN1607900000000|Shoshone County, ID
F|CN1608100000000|Teton County, ID
F|CN1608300000000|Twin Falls County, ID
F|CN1608500000000|Valley County, ID
F|CN1608700000000|Washington County, ID
F|CN1700100000000|Adams County, IL
F|CN1700300000000|Alexander County, IL
F|CN1700500000000|Bond County, IL
F|CN1700700000000|Boone County, IL
F|CN1700900000000|Brown County, IL
F|CN1701100000000|Bureau County, IL
F|CN1701300000000|Calhoun County, IL
F|CN1701500000000|Carroll County, IL
F|CN1701700000000|Cass County, IL
F|CN1701900000000|Champaign County, IL
F|CN1702100000000|Christian County, IL
F|CN1702300000000|Clark County, IL
F|CN1702500000000|Clay County, IL
F|CN1702700000000|Clinton County, IL
F|CN1702900000000|Coles County, IL
F|CN1703100000000|Cook County, IL
F|CN1703300000000|Crawford County, IL
F|CN1703500000000|Cumberland County, IL
F|CN1703700000000|DeKalb County, IL
F|CN1703900000000|De Witt County, IL
F|CN1704100000000|Douglas County, IL
F|CN1704300000000|DuPage County, IL
F|CN1704500000000|Edgar County, IL
F|CN1704700000000|Edwards County, IL
F|CN1704900000000|Effingham County, IL
F|CN1705100000000|Fayette County, IL
F|CN1705300000000|Ford County, IL
F|CN1705500000000|Franklin County, IL
F|CN1705700000000|Fulton County, IL
F|CN1705900000000|Gallatin County, IL
F|CN1706100000000|Greene County, IL
F|CN1706300000000|Grundy County, IL
F|CN1706500000000|Hamilton County, IL
F|CN1706700000000|Hancock County, IL
F|CN1706900000000|Hardin County, IL
F|CN1707100000000|Henderson County, IL
F|CN1707300000000|Henry County, IL
F|CN1707500000000|Iroquois County, IL
F|CN1707700000000|Jackson County, IL
F|CN1707900000000|Jasper County, IL
F|CN1708100000000|Jefferson County, IL
F|CN1708300000000|Jersey County, IL
F|CN1708500000000|Jo Daviess County, IL
F|CN1708700000000|Johnson County, IL
F|CN1708900000000|Kane County, IL
F|CN1709100000000|Kankakee County, IL
F|CN1709300000000|Kendall County, IL
F|CN1709500000000|Knox County, IL
F|CN1709700000000|Lake County, IL
F|CN1709900000000|LaSalle County, IL
F|CN1710100000000|Lawrence County, IL
F|CN1710300000000|Lee County, IL
F|CN1710500000000|Livingston County, IL
F|CN1710700000000|Logan County, IL
F|CN1710900000000|McDonough County, IL
F|CN1711100000000|McHenry County, IL
F|CN1711300000000|McLean County, IL
F|CN1711500000000|Macon County, IL
F|CN1711700000000|Macoupin County, IL
F|CN1711900000000|Madison County, IL
F|CN1712100000000|Marion County, IL
F|CN1712300000000|Marshall County, IL
F|CN1712500000000|Mason County, IL
F|CN1712700000000|Massac County, IL
F|CN1712900000000|Menard County, IL
F|CN1713100000000|Mercer County, IL
F|CN1713300000000|Monroe County, IL
F|CN1713500000000|Montgomery County, IL
F|CN1713700000000|Morgan County, IL
F|CN1713900000000|Moultrie County, IL
F|CN1714100000000|Ogle County, IL
F|CN1714300000000|Peoria County, IL
F|CN1714500000000|Perry County, IL
F|CN1714700000000|Piatt County, IL
F|CN1714900000000|Pike County, IL
F|CN1715100000000|Pope County, IL
F|CN1715300000000|Pulaski County, IL
F|CN1715500000000|Putnam County, IL
F|CN1715700000000|Randolph County, IL
F|CN1715900000000|Richland County, IL
F|CN1716100000000|Rock Island County, IL
F|CN1716300000000|St. Clair County, IL
F|CN1716500000000|Saline County, IL
F|CN1716700000000|Sangamon County, IL
F|CN1716900000000|Schuyler County, IL
F|CN1717100000000|Scott County, IL
F|CN1717300000000|Shelby County, IL
F|CN1717500000000|Stark County, IL
F|CN1717700000000|Stephenson County, IL
F|CN1717900000000|Tazewell County, IL
F|CN1718100000000|Union County, IL
F|CN1718300000000|Vermilion County, IL
F|CN1718500000000|Wabash County, IL
F|CN1718700000000|Warren County, IL
F|CN1718900000000|Washington County, IL
F|CN1719100000000|Wayne County, IL
F|CN1719300000000|White County, IL
F|CN1719500000000|Whiteside County, IL
F|CN1719700000000|Will County, IL
F|CN1719900000000|Williamson County, IL
F|CN1720100000000|Winnebago County, IL
F|CN1720300000000|Woodford County, IL
F|CN1800100000000|Adams County, IN
F|CN1800300000000|Allen County, IN
F|CN1800500000000|Bartholomew County, IN
F|CN1800700000000|Benton County, IN
F|CN1800900000000|Blackford County, IN
F|CN1801100000000|Boone County, IN
F|CN1801300000000|Brown County, IN
F|CN1801500000000|Carroll County, IN
F|CN1801700000000|Cass County, IN
F|CN1801900000000|Clark County, IN
F|CN1802100000000|Clay County, IN
F|CN1802300000000|Clinton County, IN
F|CN1802500000000|Crawford County, IN
F|CN1802700000000|Daviess County, IN
F|CN1802900000000|Dearborn County, IN
F|CN1803100000000|Decatur County, IN
F|CN1803300000000|DeKalb County, IN
F|CN1803500000000|Delaware County, IN
F|CN1803700000000|Dubois County, IN
F|CN1803900000000|Elkhart County, IN
F|CN1804100000000|Fayette County, IN
F|CN1804300000000|Floyd County, IN
F|CN1804500000000|Fountain County, IN
F|CN1804700000000|Franklin County, IN
F|CN1804900000000|Fulton County, IN
F|CN1805100000000|Gibson County, IN
F|CN1805300000000|Grant County, IN
F|CN1805500000000|Greene County, IN
F|CN1805700000000|Hamilton County, IN
F|CN1805900000000|Hancock County, IN
F|CN1806100000000|Harrison County, IN
F|CN1806300000000|Hendricks County, IN
F|CN1806500000000|Henry County, IN
F|CN1806700000000|Howard County, IN
F|CN1806900000000|Huntington County, IN
F|CN1807100000000|Jackson County, IN
F|CN1807300000000|Jasper County, IN
F|CN1807500000000|Jay County, IN
F|CN1807700000000|Jefferson County, IN
F|CN1807900000000|Jennings County, IN
F|CN1808100000000|Johnson County, IN
F|CN1808300000000|Knox County, IN
F|CN1808500000000|Kosciusko County, IN
F|CN1808700000000|LaGrange County, IN
F|CN1808900000000|Lake County, IN
F|CN1809100000000|LaPorte County, IN
F|CN1809300000000|Lawrence County, IN
F|CN1809500000000|Madison County, IN
F|CN1809700000000|Marion County, IN
F|CN1809900000000|Marshall County, IN
F|CN1810100000000|Martin County, IN
F|CN1810300000000|Miami County, IN
F|CN1810500000000|Monroe County, IN
F|CN1810700000000|Montgomery County, IN
F|CN1810900000000|Morgan County, IN
F|CN1811100000000|Newton County, IN
F|CN1811300000000|Noble County, IN
F|CN1811500000000|Ohio County, IN
F|CN1811700000000|Orange County, IN
F|CN1811900000000|Owen County, IN
F|CN1812100000000|Parke County, IN
F|CN1812300000000|Perry County, IN
F|CN1812500000000|Pike County, IN
F|CN1812700000000|Porter County, IN
F|CN1812900000000|Posey County, IN
F|CN1813100000000|Pulaski County, IN
F|CN1813300000000|Putnam County, IN
F|CN1813500000000|Randolph County, IN
F|CN1813700000000|Ripley County, IN
F|CN1813900000000|Rush County, IN
F|CN1814100000000|St. Joseph County, IN
F|CN1814300000000|Scott County, IN
F|CN1814500000000|Shelby County, IN
F|CN1814700000000|Spencer County, IN
F|CN1814900000000|Starke County, IN
F|CN1815100000000|Steuben County, IN
F|CN1815300000000|Sullivan County, IN
F|CN1815500000000|Switzerland County, IN
F|CN1815700000000|Tippecanoe County, IN
F|CN1815900000000|Tipton County, IN
F|CN1816100000000|Union County, IN
F|CN1816300000000|Vanderburgh County, IN
F|CN1816500000000|Vermillion County, IN
F|CN1816700000000|Vigo County, IN
F|CN1816900000000|Wabash County, IN
F|CN1817100000000|Warren County, IN
F|CN1817300000000|Warrick County, IN
F|CN1817500000000|Washington County, IN
F|CN1817700000000|Wayne County, IN
F|CN1817900000000|Wells County, IN
F|CN1818100000000|White County, IN
F|CN1818300000000|Whitley County, IN
F|CN1900100000000|Adair County, IA
F|CN1900300000000|Adams County, IA
F|CN1900500000000|Allamakee County, IA
F|CN1900700000000|Appanoose County, IA
F|CN1900900000000|Audubon County, IA
F|CN1901100000000|Benton County, IA
F|CN1901300000000|Black Hawk County, IA
F|CN1901500000000|Boone County, IA
F|CN1901700000000|Bremer County, IA
F|CN1901900000000|Buchanan County, IA
F|CN1902100000000|Buena Vista County, IA
F|CN1902300000000|Butler County, IA
F|CN1902500000000|Calhoun County, IA
F|CN1902700000000|Carroll County, IA
F|CN1902900000000|Cass County, IA
F|CN1903100000000|Cedar County, IA
F|CN1903300000000|Cerro Gordo County, IA
F|CN1903500000000|Cherokee County, IA
F|CN1903700000000|Chickasaw County, IA
F|CN1903900000000|Clarke County, IA
F|CN1904100000000|Clay County, IA
F|CN1904300000000|Clayton County, IA
F|CN1904500000000|Clinton County, IA
F|CN1904700000000|Crawford County, IA
F|CN1904900000000|Dallas County, IA
F|CN1905100000000|Davis County, IA
F|CN1905300000000|Decatur County, IA
F|CN1905500000000|Delaware County, IA
F|CN1905700000000|Des Moines County, IA
F|CN1905900000000|Dickinson County, IA
F|CN1906100000000|Dubuque County, IA
F|CN1906300000000|Emmet County, IA
F|CN1906500000000|Fayette County, IA
F|CN1906700000000|Floyd County, IA
F|CN1906900000000|Franklin County, IA
F|CN1907100000000|Fremont County, IA
F|CN1907300000000|Greene County, IA
F|CN1907500000000|Grundy County, IA
F|CN1907700000000|Guthrie County, IA
F|CN1907900000000|Hamilton County, IA
F|CN1908100000000|Hancock County, IA
F|CN1908300000000|Hardin County, IA
F|CN1908500000000|Harrison County, IA
F|CN1908700000000|Henry County, IA
F|CN1908900000000|Howard County, IA
F|CN1909100000000|Humboldt County, IA
F|CN1909300000000|Ida County, IA
F|CN1909500000000|Iowa County, IA
F|CN1909700000000|Jackson County, IA
F|CN1909900000000|Jasper County, IA
F|CN1910100000000|Jefferson County, IA
F|CN1910300000000|Johnson County, IA
F|CN1910500000000|Jones County, IA
F|CN1910700000000|Keokuk County, IA
F|CN1910900000000|Kossuth County, IA
F|CN1911100000000|Lee County, IA
F|CN1911300000000|Linn County, IA
F|CN1911500000000|Louisa County, IA
F|CN1911700000000|Lucas County, IA
F|CN1911900000000|Lyon County, IA
F|CN1912100000000|Madison County, IA
F|CN1912300000000|Mahaska County, IA
F|CN1912500000000|Marion County, IA
F|CN1912700000000|Marshall County, IA
F|CN1912900000000|Mills County, IA
F|CN1913100000000|Mitchell County, IA
F|CN1913300000000|Monona County, IA
F|CN1913500000000|Monroe County, IA
F|CN1913700000000|Montgomery County, IA
F|CN1913900000000|Muscatine County, IA
F|CN1914100000000|O'Brien County, IA
F|CN1914300000000|Osceola County, IA
F|CN1914500000000|Page County, IA
F|CN1914700000000|Palo Alto County, IA
F|CN1914900000000|Plymouth County, IA
F|CN1915100000000|Pocahontas County, IA
F|CN1915300000000|Polk County, IA
F|CN1915500000000|Pottawattamie County, IA
F|CN1915700000000|Poweshiek County, IA
F|CN1915900000000|Ringgold County, IA
F|CN1916100000000|Sac County, IA
F|CN1916300000000|Scott County, IA
F|CN1916500000000|Shelby County, IA
F|CN1916700000000|Sioux County, IA
F|CN1916900000000|Story County, IA
F|CN1917100000000|Tama County, IA
F|CN1917300000000|Taylor County, IA
F|CN1917500000000|Union County, IA
F|CN1917700000000|Van Buren County, IA
F|CN1917900000000|Wapello County, IA
F|CN1918100000000|Warren County, IA
F|CN1918300000000|Washington County, IA
F|CN1918500000000|Wayne County, IA
F|CN1918700000000|Webster County, IA
F|CN1918900000000|Winnebago County, IA
F|CN1919100000000|Winneshiek County, IA
F|CN1919300000000|Woodbury County, IA
F|CN1919500000000|Worth County, IA
F|CN1919700000000|Wright County, IA
F|CN2000100000000|Allen County, KS
F|CN2000300000000|Anderson County, KS
F|CN2000500000000|Atchison County, KS
F|CN2000700000000|Barber County, KS
F|CN2000900000000|Barton County, KS
F|CN2001100000000|Bourbon County, KS
F|CN2001300000000|Brown County, KS
F|CN2001500000000|Butler County, KS
F|CN2001700000000|Chase County, KS
F|CN2001900000000|Chautauqua County, KS
F|CN2002100000000|Cherokee County, KS
F|CN2002300000000|Cheyenne County, KS
F|CN2002500000000|Clark County, KS
F|CN2002700000000|Clay County, KS
F|CN2002900000000|Cloud County, KS
F|CN2003100000000|Coffey County, KS
F|CN2003300000000|Comanche County, KS
F|CN2003500000000|Cowley County, KS
F|CN2003700000000|Crawford County, KS
F|CN2003900000000|Decatur County, KS
F|CN2004100000000|Dickinson County, KS
F|CN2004300000000|Doniphan County, KS
F|CN2004500000000|Douglas County, KS
F|CN2004700000000|Edwards County, KS
F|CN2004900000000|Elk County, KS
F|CN2005100000000|Ellis County, KS
F|CN2005300000000|Ellsworth County, KS
F|CN2005500000000|Finney County, KS
F|CN2005700000000|Ford County, KS
F|CN2005900000000|Franklin County, KS
F|CN2006100000000|Geary County, KS
F|CN2006300000000|Gove County, KS
F|CN2006500000000|Graham County, KS
F|CN2006700000000|Grant County, KS
F|CN2006900000000|Gray County, KS
F|CN2007100000000|Greeley County, KS
F|CN2007300000000|Greenwood County, KS
F|CN2007500000000|Hamilton County, KS
F|CN2007700000000|Harper County, KS
F|CN2007900000000|Harvey County, KS
F|CN2008100000000|Haskell County, KS
F|CN2008300000000|Hodgeman County, KS
F|CN2008500000000|Jackson County, KS
F|CN2008700000000|Jefferson County, KS
F|CN2008900000000|Jewell County, KS
F|CN2009100000000|Johnson County, KS
F|CN2009300000000|Kearny County, KS
F|CN2009500000000|Kingman County, KS
F|CN2009700000000|Kiowa County, KS
F|CN2009900000000|Labette County, KS
F|CN2010100000000|Lane County, KS
F|CN2010300000000|Leavenworth County, KS
F|CN2010500000000|Lincoln County, KS
F|CN2010700000000|Linn County, KS
F|CN2010900000000|Logan County, KS
F|CN2011100000000|Lyon County, KS
F|CN2011300000000|McPherson County, KS
F|CN2011500000000|Marion County, KS
F|CN2011700000000|Marshall County, KS
F|CN2011900000000|Meade County, KS
F|CN2012100000000|Miami County, KS
F|CN2012300000000|Mitchell County, KS
F|CN2012500000000|Montgomery County, KS
F|CN2012700000000|Morris County, KS
F|CN2012900000000|Morton County, KS
F|CN2013100000000|Nemaha County, KS
F|CN2013300000000|Neosho County, KS
F|CN2013500000000|Ness County, KS
F|CN2013700000000|Norton County, KS
F|CN2013900000000|Osage County, KS
F|CN2014100000000|Osborne County, KS
F|CN2014300000000|Ottawa County, KS
F|CN2014500000000|Pawnee County, KS
F|CN2014700000000|Phillips County, KS
F|CN2014900000000|Pottawatomie County, KS
F|CN2015100000000|Pratt County, KS
F|CN2015300000000|Rawlins County, KS
F|CN2015500000000|Reno County, KS
F|CN2015700000000|Republic County, KS
F|CN2015900000000|Rice County, KS
F|CN2016100000000|Riley County, KS
F|CN2016300000000|Rooks County, KS
F|CN2016500000000|Rush County, KS
F|CN2016700000000|Russell County, KS
F|CN2016900000000|Saline County, KS
F|CN2017100000000|Scott County, KS
F|CN2017300000000|Sedgwick County, KS
F|CN2017500000000|Seward County, KS
F|CN2017700000000|Shawnee County, KS
F|CN2017900000000|Sheridan County, KS
F|CN2018100000000|Sherman County, KS
F|CN2018300000000|Smith County, KS
F|CN2018500000000|Stafford County, KS
F|CN2018700000000|Stanton County, KS
F|CN2018900000000|Stevens County, KS
F|CN2019100000000|Sumner County, KS
F|CN2019300000000|Thomas County, KS
F|CN2019500000000|Trego County, KS
F|CN2019700000000|Wabaunsee County, KS
F|CN2019900000000|Wallace County, KS
F|CN2020100000000|Washington County, KS
F|CN2020300000000|Wichita County, KS
F|CN2020500000000|Wilson County, KS
F|CN2020700000000|Woodson County, KS
F|CN2020900000000|Wyandotte County, KS
F|CN2100100000000|Adair County, KY
F|CN2100300000000|Allen County, KY
F|CN2100500000000|Anderson County, KY
F|CN2100700000000|Ballard County, KY
F|CN2100900000000|Barren County, KY
F|CN2101100000000|Bath County, KY
F|CN2101300000000|Bell County, KY
F|CN2101500000000|Boone County, KY
F|CN2101700000000|Bourbon County, KY
F|CN2101900000000|Boyd County, KY
F|CN2102100000000|Boyle County, KY
F|CN2102300000000|Bracken County, KY
F|CN2102500000000|Breathitt County, KY
F|CN2102700000000|Breckinridge County, KY
F|CN2102900000000|Bullitt County, KY
F|CN2103100000000|Butler County, KY
F|CN2103300000000|Caldwell County, KY
F|CN2103500000000|Calloway County, KY
F|CN2103700000000|Campbell County, KY
F|CN2103900000000|Carlisle County, KY
F|CN2104100000000|Carroll County, KY
F|CN2104300000000|Carter County, KY
F|CN2104500000000|Casey County, KY
F|CN2104700000000|Christian County, KY
F|CN2104900000000|Clark County, KY
F|CN2105100000000|Clay County, KY
F|CN2105300000000|Clinton County, KY
F|CN2105500000000|Crittenden County, KY
F|CN2105700000000|Cumberland County, KY
F|CN2105900000000|Daviess County, KY
F|CN2106100000000|Edmonson County, KY
F|CN2106300000000|Elliott County, KY
F|CN2106500000000|Estill County, KY
F|CN2106700000000|Fayette County, KY
F|CN2106900000000|Fleming County, KY
F|CN2107100000000|Floyd County, KY
F|CN2107300000000|Franklin County, KY
F|CN2107500000000|Fulton County, KY
F|CN2107700000000|Gallatin County, KY
F|CN2107900000000|Garrard County, KY
F|CN2108100000000|Grant County, KY
F|CN2108300000000|Graves County, KY
F|CN2108500000000|Grayson County, KY
F|CN2108700000000|Green County, KY
F|CN2108900000000|Greenup County, KY
F|CN2109100000000|Hancock County, KY
F|CN2109300000000|Hardin County, KY
F|CN2109500000000|Harlan County, KY
F|CN2109700000000|Harrison County, KY
F|CN2109900000000|Hart County, KY
F|CN2110100000000|Henderson County, KY
F|CN2110300000000|Henry County, KY
F|CN2110500000000|Hickman County, KY
F|CN2110700000000|Hopkins County, KY
F|CN2110900000000|Jackson County, KY
F|CN2111100000000|Jefferson County, KY
F|CN2111300000000|Jessamine County, KY
F|CN2111500000000|Johnson County, KY
F|CN2111700000000|Kenton County, KY
F|CN2111900000000|Knott County, KY
F|CN2112100000000|Knox County, KY
F|CN2112300000000|Larue County, KY
F|CN2112500000000|Laurel County, KY
F|CN2112700000000|Lawrence County, KY
F|CN2112900000000|Lee County, KY
F|CN2113100000000|Leslie County, KY
F|CN2113300000000|Letcher County, KY
F|CN2113500000000|Lewis County, KY
F|CN2113700000000|Lincoln County, KY
F|CN2113900000000|Livingston County, KY
F|CN2114100000000|Logan County, KY
F|CN2114300000000|Lyon County, KY
F|CN2114500000000|McCracken County, KY
F|CN2114700000000|McCreary County, KY
F|CN2114900000000|McLean County, KY
F|CN2115100000000|Madison County, KY
F|CN2115300000000|Magoffin County, KY
F|CN2115500000000|Marion County, KY
F|CN2115700000000|Marshall County, KY
F|CN2115900000000|Martin County, KY
F|CN2116100000000|Mason County, KY
F|CN2116300000000|Meade County, KY
F|CN2116500000000|Menifee County, KY
F|CN2116700000000|Mercer County, KY
F|CN2116900000000|Metcalfe County, KY
F|CN2117100000000|Monroe County, KY
F|CN2117300000000|Montgomery County, KY
F|CN2117500000000|Morgan County, KY
F|CN2117700000000|Muhlenberg County, KY
F|CN2117900000000|Nelson County, KY
F|CN2118100000000|Nicholas County, KY
F|CN2118300000000|Ohio County, KY
F|CN2118500000000|Oldham County, KY
F|CN2118700000000|Owen County, KY
F|CN2118900000000|Owsley County, KY
F|CN2119100000000|Pendleton County, KY
F|CN2119300000000|Perry County, KY
F|CN2119500000000|Pike County, KY
F|CN2119700000000|Powell County, KY
F|CN2119900000000|Pulaski County, KY
F|CN2120100000000|Robertson County, KY
F|CN2120300000000|Rockcastle County, KY
F|CN2120500000000|Rowan County, KY
F|CN2120700000000|Russell County, KY
F|CN2120900000000|Scott County, KY
F|CN2121100000000|Shelby County, KY
F|CN2121300000000|Simpson County, KY
F|CN2121500000000|Spencer County, KY
F|CN2121700000000|Taylor County, KY
F|CN2121900000000|Todd County, KY
F|CN2122100000000|Trigg County, KY
F|CN2122300000000|Trimble County, KY
F|CN2122500000000|Union County, KY
F|CN2122700000000|Warren County, KY
F|CN2122900000000|Washington County, KY
F|CN2123100000000|Wayne County, KY
F|CN2123300000000|Webster County, KY
F|CN2123500000000|Whitley County, KY
F|CN2123700000000|Wolfe County, KY
F|CN2123900000000|Woodford County, KY
F|CN2200100000000|Acadia Parish, LA
F|CN2200300000000|Allen Parish, LA
F|CN2200500000000|Ascension Parish, LA
F|CN2200700000000|Assumption Parish, LA
F|CN2200900000000|Avoyelles Parish, LA
F|CN2201100000000|Beauregard Parish, LA
F|CN2201300000000|Bienville Parish, LA
F|CN2201500000000|Bossier Parish, LA
F|CN2201700000000|Caddo Parish, LA
F|CN2201900000000|Calcasieu Parish, LA
F|CN2202100000000|Caldwell Parish, LA
F|CN2202300000000|Cameron Parish, LA
F|CN2202500000000|Catahoula Parish, LA
F|CN2202700000000|Claiborne Parish, LA
F|CN2202900000000|Concordia Parish, LA
F|CN2203100000000|De Soto Parish, LA
F|CN2203300000000|East Baton Rouge Parish, LA
F|CN2203500000000|East Carroll Parish, LA
F|CN2203700000000|East Feliciana Parish, LA
F|CN2203900000000|Evangeline Parish, LA
F|CN2204100000000|Franklin Parish, LA
F|CN2204300000000|Grant Parish, LA
F|CN2204500000000|Iberia Parish, LA
F|CN2204700000000|Iberville Parish, LA
F|CN2204900000000|Jackson Parish, LA
F|CN2205100000000|Jefferson Parish, LA
F|CN2205300000000|Jefferson Davis Parish, LA
F|CN2205500000000|Lafayette Parish, LA
F|CN2205700000000|Lafourche Parish, LA
F|CN2205900000000|LaSalle Parish, LA
F|CN2206100000000|Lincoln Parish, LA
F|CN2206300000000|Livingston Parish, LA
F|CN2206500000000|Madison Parish, LA
F|CN2206700000000|Morehouse Parish, LA
F|CN2206900000000|Natchitoches Parish, LA
F|CN2207100000000|Orleans Parish, LA
F|CN2207300000000|Ouachita Parish, LA
F|CN2207500000000|Plaquemines Parish, LA
F|CN2207700000000|Pointe Coupee Parish, LA
F|CN2207900000000|Rapides Parish, LA
F|CN2208100000000|Red River Parish, LA
F|CN2208300000000|Richland Parish, LA
F|CN2208500000000|Sabine Parish, LA
F|CN2208700000000|St. Bernard Parish, LA
F|CN2208900000000|St. Charles Parish, LA
F|CN2209100000000|St. Helena Parish, LA
F|CN2209300000000|St. James Parish, LA
F|CN2209500000000|St. John the Baptist Parish, LA
F|CN2209700000000|St. Landry Parish, LA
F|CN2209900000000|St. Martin Parish, LA
F|CN2210100000000|St. Mary Parish, LA
F|CN2210300000000|St. Tammany Parish, LA
F|CN2210500000000|Tangipahoa Parish, LA
F|CN2210700000000|Tensas Parish, LA
F|CN2210900000000|Terrebonne Parish, LA
F|CN2211100000000|Union Parish, LA
F|CN2211300000000|Vermilion Parish, LA
F|CN2211500000000|Vernon Parish, LA
F|CN2211700000000|Washington Parish, LA
F|CN2211900000000|Webster Parish, LA
F|CN2212100000000|West Baton Rouge Parish, LA
F|CN2212300000000|West Carroll Parish, LA
F|CN2212500000000|West Feliciana Parish, LA
F|CN2212700000000|Winn Parish, LA
F|CN2300100000000|Androscoggin County, ME
F|CN2300300000000|Aroostook County, ME
F|CN2300500000000|Cumberland County, ME
F|CN2300700000000|Franklin County, ME
F|CN2300900000000|Hancock County, ME
F|CN2301100000000|Kennebec County, ME
F|CN2301300000000|Knox County, ME
F|CN2301500000000|Lincoln County, ME
F|CN2301700000000|Oxford County, ME
F|CN2301900000000|Penobscot County, ME
F|CN2302100000000|Piscataquis County, ME
F|CN2302300000000|Sagadahoc County, ME
F|CN2302500000000|Somerset County, ME
F|CN2302700000000|Waldo County, ME
F|CN2302900000000|Washington County, ME
F|CN2303100000000|York County, ME
F|CN2400100000000|Allegany County, MD
F|CN2400300000000|Anne Arundel County, MD
F|CN2400500000000|Baltimore County, MD
F|CN2400900000000|Calvert County, MD
F|CN2401100000000|Caroline County, MD
F|CN2401300000000|Carroll County, MD
F|CN2401500000000|Cecil County, MD
F|CN2401700000000|Charles County, MD
F|CN2401900000000|Dorchester County, MD
F|CN2402100000000|Frederick County, MD
F|CN2402300000000|Garrett County, MD
F|CN2402500000000|Harford County, MD
F|CN2402700000000|Howard County, MD
F|CN2402900000000|Kent County, MD
F|CN2403100000000|Montgomery County, MD
F|CN2403300000000|Prince George's County, MD
F|CN2403500000000|Queen Anne's County, MD
F|CN2403700000000|St. Mary's County, MD
F|CN2403900000000|Somerset County, MD
F|CN2404100000000|Talbot County, MD
F|CN2404300000000|Washington County, MD
F|CN2404500000000|Wicomico County, MD
F|CN2404700000000|Worcester County, MD
F|CN2451000000000|Baltimore city, MD
F|CN2500100000000|Barnstable County, MA
F|CN2500300000000|Berkshire County, MA
F|CN2500500000000|Bristol County, MA
F|CN2500700000000|Dukes County, MA
F|CN2500900000000|Essex County, MA
F|CN2501100000000|Franklin County, MA
F|CN2501300000000|Hampden County, MA
F|CN2501500000000|Hampshire County, MA
F|CN2501700000000|Middlesex County, MA
F|CN2501900000000|Nantucket County/town, MA
F|CN2502100000000|Norfolk County, MA
F|CN2502300000000|Plymouth County, MA
F|CN2502500000000|Suffolk County, MA
F|CN2502700000000|Worcester County, MA
F|CN2600100000000|Alcona County, MI
F|CN2600300000000|Alger County, MI
F|CN2600500000000|Allegan County, MI
F|CN2600700000000|Alpena County, MI
F|CN2600900000000|Antrim County, MI
F|CN2601100000000|Arenac County, MI
F|CN2601300000000|Baraga County, MI
F|CN2601500000000|Barry County, MI
F|CN2601700000000|Bay County, MI
F|CN2601900000000|Benzie County, MI
F|CN2602100000000|Berrien County, MI
F|CN2602300000000|Branch County, MI
F|CN2602500000000|Calhoun County, MI
F|CN2602700000000|Cass County, MI
F|CN2602900000000|Charlevoix County, MI
F|CN2603100000000|Cheboygan County, MI
F|CN2603300000000|Chippewa County, MI
F|CN2603500000000|Clare County, MI
F|CN2603700000000|Clinton County, MI
F|CN2603900000000|Crawford County, MI
F|CN2604100000000|Delta County, MI
F|CN2604300000000|Dickinson County, MI
F|CN2604500000000|Eaton County, MI
F|CN2604700000000|Emmet County, MI
F|CN2604900000000|Genesee County, MI
F|CN2605100000000|Gladwin County, MI
F|CN2605300000000|Gogebic County, MI
F|CN2605500000000|Grand Traverse County, MI
F|CN2605700000000|Gratiot County, MI
F|CN2605900000000|Hillsdale County, MI
F|CN2606100000000|Houghton County, MI
F|CN2606300000000|Huron County, MI
F|CN2606500000000|Ingham County, MI
F|CN2606700000000|Ionia County, MI
F|CN2606900000000|Iosco County, MI
F|CN2607100000000|Iron County, MI
F|CN2607300000000|Isabella County, MI
F|CN2607500000000|Jackson County, MI
F|CN2607700000000|Kalamazoo County, MI
F|CN2607900000000|Kalkaska County, MI
F|CN2608100000000|Kent County, MI
F|CN2608300000000|Keweenaw County, MI
F|CN2608500000000|Lake County, MI
F|CN2608700000000|Lapeer County, MI
F|CN2608900000000|Leelanau County, MI
F|CN2609100000000|Lenawee County, MI
F|CN2609300000000|Livingston County, MI
F|CN2609500000000|Luce County, MI
F|CN2609700000000|Mackinac County, MI
F|CN2609900000000|Macomb County, MI
F|CN2610100000000|Manistee County, MI
F|CN2610300000000|Marquette County, MI
F|CN2610500000000|Mason County, MI
F|CN2610700000000|Mecosta County, MI
F|CN2610900000000|Menominee County, MI
F|CN2611100000000|Midland County, MI
F|CN2611300000000|Missaukee County, MI
F|CN2611500000000|Monroe County, MI
F|CN2611700000000|Montcalm County, MI
F|CN2611900000000|Montmorency County, MI
F|CN2612100000000|Muskegon County, MI
F|CN2612300000000|Newaygo County, MI
F|CN2612500000000|Oakland County, MI
F|CN2612700000000|Oceana County, MI
F|CN2612900000000|Ogemaw County, MI
F|CN2613100000000|Ontonagon County, MI
F|CN2613300000000|Osceola County, MI
F|CN2613500000000|Oscoda County, MI
F|CN2613700000000|Otsego County, MI
F|CN2613900000000|Ottawa County, MI
F|CN2614100000000|Presque Isle County, MI
F|CN2614300000000|Roscommon County, MI
F|CN2614500000000|Saginaw County, MI
F|CN2614700000000|St. Clair County, MI
F|CN2614900000000|St. Joseph County, MI
F|CN2615100000000|Sanilac County, MI
F|CN2615300000000|Schoolcraft County, MI
F|CN2615500000000|Shiawassee County, MI
F|CN2615700000000|Tuscola County, MI
F|CN2615900000000|Van Buren County, MI
F|CN2616100000000|Washtenaw County, MI
F|CN2616300000000|Wayne County, MI
F|CN2616500000000|Wexford County, MI
F|CN2700100000000|Aitkin County, MN
F|CN2700300000000|Anoka County, MN
F|CN2700500000000|Becker County, MN
F|CN2700700000000|Beltrami County, MN
F|CN2700900000000|Benton County, MN
F|CN2701100000000|Big Stone County, MN
F|CN2701300000000|Blue Earth County, MN
F|CN2701500000000|Brown County, MN
F|CN2701700000000|Carlton County, MN
F|CN2701900000000|Carver County, MN
F|CN2702100000000|Cass County, MN
F|CN2702300000000|Chippewa County, MN
F|CN2702500000000|Chisago County, MN
F|CN2702700000000|Clay County, MN
F|CN2702900000000|Clearwater County, MN
F|CN2703100000000|Cook County, MN
F|CN2703300000000|Cottonwood County, MN
F|CN2703500000000|Crow Wing County, MN
F|CN2703700000000|Dakota County, MN
F|CN2703900000000|Dodge County, MN
F|CN2704100000000|Douglas County, MN
F|CN2704300000000|Faribault County, MN
F|CN2704500000000|Fillmore County, MN
F|CN2704700000000|Freeborn County, MN
F|CN2704900000000|Goodhue County, MN
F|CN2705100000000|Grant County, MN
F|CN2705300000000|Hennepin County, MN
F|CN2705500000000|Houston County, MN
F|CN2705700000000|Hubbard County, MN
F|CN2705900000000|Isanti County, MN
F|CN2706100000000|Itasca County, MN
F|CN2706300000000|Jackson County, MN
F|CN2706500000000|Kanabec County, MN
F|CN2706700000000|Kandiyohi County, MN
F|CN2706900000000|Kittson County, MN
F|CN2707100000000|Koochiching County, MN
F|CN2707300000000|Lac qui Parle County, MN
F|CN2707500000000|Lake County, MN
F|CN2707700000000|Lake of the Woods County, MN
F|CN2707900000000|Le Sueur County, MN
F|CN2708100000000|Lincoln County, MN
F|CN2708300000000|Lyon County, MN
F|CN2708500000000|McLeod County, MN
F|CN2708700000000|Mahnomen County, MN
F|CN2708900000000|Marshall County, MN
F|CN2709100000000|Martin County, MN
F|CN2709300000000|Meeker County, MN
F|CN2709500000000|Mille Lacs County, MN
F|CN2709700000000|Morrison County, MN
F|CN2709900000000|Mower County, MN
F|CN2710100000000|Murray County, MN
F|CN2710300000000|Nicollet County, MN
F|CN2710500000000|Nobles County, MN
F|CN2710700000000|Norman County, MN
F|CN2710900000000|Olmsted County, MN
F|CN2711100000000|Otter Tail County, MN
F|CN2711300000000|Pennington County, MN
F|CN2711500000000|Pine County, MN
F|CN2711700000000|Pipestone County, MN
F|CN2711900000000|Polk County, MN
F|CN2712100000000|Pope County, MN
F|CN2712300000000|Ramsey County, MN
F|CN2712500000000|Red Lake County, MN
F|CN2712700000000|Redwood County, MN
F|CN2712900000000|Renville County, MN
F|CN2713100000000|Rice County, MN
F|CN2713300000000|Rock County, MN
F|CN2713500000000|Roseau County, MN
F|CN2713700000000|St. Louis County, MN
F|CN2713900000000|Scott County, MN
F|CN2714100000000|Sherburne County, MN
F|CN2714300000000|Sibley County, MN
F|CN2714500000000|Stearns County, MN
F|CN2714700000000|Steele County, MN
F|CN2714900000000|Stevens County, MN
F|CN2715100000000|Swift County, MN
F|CN2715300000000|Todd County, MN
F|CN2715500000000|Traverse County, MN
F|CN2715700000000|Wabasha County, MN
F|CN2715900000000|Wadena County, MN
F|CN2716100000000|Waseca County, MN
F|CN2716300000000|Washington County, MN
F|CN2716500000000|Watonwan County, MN
F|CN2716700000000|Wilkin County, MN
F|CN2716900000000|Winona County, MN
F|CN2717100000000|Wright County, MN
F|CN2717300000000|Yellow Medicine County, MN
F|CN2800100000000|Adams County, MS
F|CN2800300000000|Alcorn County, MS
F|CN2800500000000|Amite County, MS
F|CN2800700000000|Attala County, MS
F|CN2800900000000|Benton County, MS
F|CN2801100000000|Bolivar County, MS
F|CN2801300000000|Calhoun County, MS
F|CN2801500000000|Carroll County, MS
F|CN2801700000000|Chickasaw County, MS
F|CN2801900000000|Choctaw County, MS
F|CN2802100000000|Claiborne County, MS
F|CN2802300000000|Clarke County, MS
F|CN2802500000000|Clay County, MS
F|CN2802700000000|Coahoma County, MS
F|CN2802900000000|Copiah County, MS
F|CN2803100000000|Covington County, MS
F|CN2803300000000|DeSoto County, MS
F|CN2803500000000|Forrest County, MS
F|CN2803700000000|Franklin County, MS
F|CN2803900000000|George County, MS
F|CN2804100000000|Greene County, MS
F|CN2804300000000|Grenada County, MS
F|CN2804500000000|Hancock County, MS
F|CN2804700000000|Harrison County, MS
F|CN2804900000000|Hinds County, MS
F|CN2805100000000|Holmes County, MS
F|CN2805300000000|Humphreys County, MS
F|CN2805500000000|Issaquena County, MS
F|CN2805700000000|Itawamba County, MS
F|CN2805900000000|Jackson County, MS
F|CN2806100000000|Jasper County, MS
F|CN2806300000000|Jefferson County, MS
F|CN2806500000000|Jefferson Davis County, MS
F|CN2806700000000|Jones County, MS
F|CN2806900000000|Kemper County, MS
F|CN2807100000000|Lafayette County, MS
F|CN2807300000000|Lamar County, MS
F|CN2807500000000|Lauderdale County, MS
F|CN2807700000000|Lawrence County, MS
F|CN2807900000000|Leake County, MS
F|CN2808100000000|Lee County, MS
F|CN2808300000000|Leflore County, MS
F|CN2808500000000|Lincoln County, MS
F|CN2808700000000|Lowndes County, MS
F|CN2808900000000|Madison County, MS
F|CN2809100000000|Marion County, MS
F|CN2809300000000|Marshall County, MS
F|CN2809500000000|Monroe County, MS
F|CN2809700000000|Montgomery County, MS
F|CN2809900000000|Neshoba County, MS
F|CN2810100000000|Newton County, MS
F|CN2810300000000|Noxubee County, MS
F|CN2810500000000|Oktibbeha County, MS
F|CN2810700000000|Panola County, MS
F|CN2810900000000|Pearl River County, MS
F|CN2811100000000|Perry County, MS
F|CN2811300000000|Pike County, MS
F|CN2811500000000|Pontotoc County, MS
F|CN2811700000000|Prentiss County, MS
F|CN2811900000000|Quitman County, MS
F|CN2812100000000|Rankin County, MS
F|CN2812300000000|Scott County, MS
F|CN2812500000000|Sharkey County, MS
F|CN2812700000000|Simpson County, MS
F|CN2812900000000|Smith County, MS
F|CN2813100000000|Stone County, MS
F|CN2813300000000|Sunflower County, MS
F|CN2813500000000|Tallahatchie County, MS
F|CN2813700000000|Tate County, MS
F|CN2813900000000|Tippah County, MS
F|CN2814100000000|Tishomingo County, MS
F|CN2814300000000|Tunica County, MS
F|CN2814500000000|Union County, MS
F|CN2814700000000|Walthall County, MS
F|CN2814900000000|Warren County, MS
F|CN2815100000000|Washington County, MS
F|CN2815300000000|Wayne County, MS
F|CN2815500000000|Webster County, MS
F|CN2815700000000|Wilkinson County, MS
F|CN2815900000000|Winston County, MS
F|CN2816100000000|Yalobusha County, MS
F|CN2816300000000|Yazoo County, MS
F|CN2900100000000|Adair County, MO
F|CN2900300000000|Andrew County, MO
F|CN2900500000000|Atchison County, MO
F|CN2900700000000|Audrain County, MO
F|CN2900900000000|Barry County, MO
F|CN2901100000000|Barton County, MO
F|CN2901300000000|Bates County, MO
F|CN2901500000000|Benton County, MO
F|CN2901700000000|Bollinger County, MO
F|CN2901900000000|Boone County, MO
F|CN2902100000000|Buchanan County, MO
F|CN2902300000000|Butler County, MO
F|CN2902500000000|Caldwell County, MO
F|CN2902700000000|Callaway County, MO
F|CN2902900000000|Camden County, MO
F|CN2903100000000|Cape Girardeau County, MO
F|CN2903300000000|Carroll County, MO
F|CN2903500000000|Carter County, MO
F|CN2903700000000|Cass County, MO
F|CN2903900000000|Cedar County, MO
F|CN2904100000000|Chariton County, MO
F|CN2904300000000|Christian County, MO
F|CN2904500000000|Clark County, MO
F|CN2904700000000|Clay County, MO
F|CN2904900000000|Clinton County, MO
F|CN2905100000000|Cole County, MO
F|CN2905300000000|Cooper County, MO
F|CN2905500000000|Crawford County, MO
F|CN2905700000000|Dade County, MO
F|CN2905900000000|Dallas County, MO
F|CN2906100000000|Daviess County, MO
F|CN2906300000000|DeKalb County, MO
F|CN2906500000000|Dent County, MO
F|CN2906700000000|Douglas County, MO
F|CN2906900000000|Dunklin County, MO
F|CN2907100000000|Franklin County, MO
F|CN2907300000000|Gasconade County, MO
F|CN2907500000000|Gentry County, MO
F|CN2907700000000|Greene County, MO
F|CN2907900000000|Grundy County, MO
F|CN2908100000000|Harrison County, MO
F|CN2908300000000|Henry County, MO
F|CN2908500000000|Hickory County, MO
F|CN2908700000000|Holt County, MO
F|CN2908900000000|Howard County, MO
F|CN2909100000000|Howell County, MO
F|CN2909300000000|Iron County, MO
F|CN2909500000000|Jackson County, MO
F|CN2909700000000|Jasper County, MO
F|CN2909900000000|Jefferson County, MO
F|CN2910100000000|Johnson County, MO
F|CN2910300000000|Knox County, MO
F|CN2910500000000|Laclede County, MO
F|CN2910700000000|Lafayette County, MO
F|CN2910900000000|Lawrence County, MO
F|CN2911100000000|Lewis County, MO
F|CN2911300000000|Lincoln County, MO
F|CN2911500000000|Linn County, MO
F|CN2911700000000|Livingston County, MO
F|CN2911900000000|McDonald County, MO
F|CN2912100000000|Macon County, MO
F|CN2912300000000|Madison County, MO
F|CN2912500000000|Maries County, MO
F|CN2912700000000|Marion County, MO
F|CN2912900000000|Mercer County, MO
F|CN2913100000000|Miller County, MO
F|CN2913300000000|Mississippi County, MO
F|CN2913500000000|Moniteau County, MO
F|CN2913700000000|Monroe County, MO
F|CN2913900000000|Montgomery County, MO
F|CN2914100000000|Morgan County, MO
F|CN2914300000000|New Madrid County, MO
F|CN2914500000000|Newton County, MO
F|CN2914700000000|Nodaway County, MO
F|CN2914900000000|Oregon County, MO
F|CN2915100000000|Osage County, MO
F|CN2915300000000|Ozark County, MO
F|CN2915500000000|Pemiscot County, MO
F|CN2915700000000|Perry County, MO
F|CN2915900000000|Pettis County, MO
F|CN2916100000000|Phelps County, MO
F|CN2916300000000|Pike County, MO
F|CN2916500000000|Platte County, MO
F|CN2916700000000|Polk County, MO
F|CN2916900000000|Pulaski County, MO
F|CN2917100000000|Putnam County, MO
F|CN2917300000000|Ralls County, MO
F|CN2917500000000|Randolph County, MO
F|CN2917700000000|Ray County, MO
F|CN2917900000000|Reynolds County, MO
F|CN2918100000000|Ripley County, MO
F|CN2918300000000|St. Charles County, MO
F|CN2918500000000|St. Clair County, MO
F|CN2918600000000|Ste. Genevieve County, MO
F|CN2918700000000|St. Francois County, MO
F|CN2918900000000|St. Louis County, MO
F|CN2919500000000|Saline County, MO
F|CN2919700000000|Schuyler County, MO
F|CN2919900000000|Scotland County, MO
F|CN2920100000000|Scott County, MO
F|CN2920300000000|Shannon County, MO
F|CN2920500000000|Shelby County, MO
F|CN2920700000000|Stoddard County, MO
F|CN2920900000000|Stone County, MO
F|CN2921100000000|Sullivan County, MO
F|CN2921300000000|Taney County, MO
F|CN2921500000000|Texas County, MO
F|CN2921700000000|Vernon County, MO
F|CN2921900000000|Warren County, MO
F|CN2922100000000|Washington County, MO
F|CN2922300000000|Wayne County, MO
F|CN2922500000000|Webster County, MO
F|CN2922700000000|Worth County, MO
F|CN2922900000000|Wright County, MO
F|CN2951000000000|St. Louis city, MO
F|CN3000100000000|Beaverhead County, MT
F|CN3000300000000|Big Horn County, MT
F|CN3000500000000|Blaine County, MT
F|CN3000700000000|Broadwater County, MT
F|CN3000900000000|Carbon County, MT
F|CN3001100000000|Carter County, MT
F|CN3001300000000|Cascade County, MT
F|CN3001500000000|Chouteau County, MT
F|CN3001700000000|Custer County, MT
F|CN3001900000000|Daniels County, MT
F|CN3002100000000|Dawson County, MT
F|CN3002300000000|Deer Lodge County, MT
F|CN3002500000000|Fallon County, MT
F|CN3002700000000|Fergus County, MT
F|CN3002900000000|Flathead County, MT
F|CN3003100000000|Gallatin County, MT
F|CN3003300000000|Garfield County, MT
F|CN3003500000000|Glacier County, MT
F|CN3003700000000|Golden Valley County, MT
F|CN3003900000000|Granite County, MT
F|CN3004100000000|Hill County, MT
F|CN3004300000000|Jefferson County, MT
F|CN3004500000000|Judith Basin County, MT
F|CN3004700000000|Lake County, MT
F|CN3004900000000|Lewis and Clark County, MT
F|CN3005100000000|Liberty County, MT
F|CN3005300000000|Lincoln County, MT
F|CN3005500000000|McCone County, MT
F|CN3005700000000|Madison County, MT
F|CN3005900000000|Meagher County, MT
F|CN3006100000000|Mineral County, MT
F|CN3006300000000|Missoula County, MT
F|CN3006500000000|Musselshell County, MT
F|CN3006700000000|Park County, MT
F|CN3006900000000|Petroleum County, MT
F|CN3007100000000|Phillips County, MT
F|CN3007300000000|Pondera County, MT
F|CN3007500000000|Powder River County, MT
F|CN3007700000000|Powell County, MT
F|CN3007900000000|Prairie County, MT
F|CN3008100000000|Ravalli County, MT
F|CN3008300000000|Richland County, MT
F|CN3008500000000|Roosevelt County, MT
F|CN3008700000000|Rosebud County, MT
F|CN3008900000000|Sanders County, MT
F|CN3009100000000|Sheridan County, MT
F|CN3009300000000|Silver Bow County, MT
F|CN3009500000000|Stillwater County, MT
F|CN3009700000000|Sweet Grass County, MT
F|CN3009900000000|Teton County, MT
F|CN3010100000000|Toole County, MT
F|CN3010300000000|Treasure County, MT
F|CN3010500000000|Valley County, MT
F|CN3010700000000|Wheatland County, MT
F|CN3010900000000|Wibaux County, MT
F|CN3011100000000|Yellowstone County, MT
F|CN3100100000000|Adams County, NE
F|CN3100300000000|Antelope County, NE
F|CN3100500000000|Arthur County, NE
F|CN3100700000000|Banner County, NE
F|CN3100900000000|Blaine County, NE
F|CN3101100000000|Boone County, NE
F|CN3101300000000|Box Butte County, NE
F|CN3101500000000|Boyd County, NE
F|CN3101700000000|Brown County, NE
F|CN3101900000000|Buffalo County, NE
F|CN3102100000000|Burt County, NE
F|CN3102300000000|Butler County, NE
F|CN3102500000000|Cass County, NE
F|CN3102700000000|Cedar County, NE
F|CN3102900000000|Chase County, NE
F|CN3103100000000|Cherry County, NE
F|CN3103300000000|Cheyenne County, NE
F|CN3103500000000|Clay County, NE
F|CN3103700000000|Colfax County, NE
F|CN3103900000000|Cuming County, NE
F|CN3104100000000|Custer County, NE
F|CN3104300000000|Dakota County, NE
F|CN3104500000000|Dawes County, NE
F|CN3104700000000|Dawson County, NE
F|CN3104900000000|Deuel County, NE
F|CN3105100000000|Dixon County, NE
F|CN3105300000000|Dodge County, NE
F|CN3105500000000|Douglas County, NE
F|CN3105700000000|Dundy County, NE
F|CN3105900000000|Fillmore County, NE
F|CN3106100000000|Franklin County, NE
F|CN3106300000000|Frontier County, NE
F|CN3106500000000|Furnas County, NE
F|CN3106700000000|Gage County, NE
F|CN3106900000000|Garden County, NE
F|CN3107100000000|Garfield County, NE
F|CN3107300000000|Gosper County, NE
F|CN3107500000000|Grant County, NE
F|CN3107700000000|Greeley County, NE
F|CN3107900000000|Hall County, NE
F|CN3108100000000|Hamilton County, NE
F|CN3108300000000|Harlan County, NE
F|CN3108500000000|Hayes County, NE
F|CN3108700000000|Hitchcock County, NE
F|CN3108900000000|Holt County, NE
F|CN3109100000000|Hooker County, NE
F|CN3109300000000|Howard County, NE
F|CN3109500000000|Jefferson County, NE
F|CN3109700000000|Johnson County, NE
F|CN3109900000000|Kearney County, NE
F|CN3110100000000|Keith County, NE
F|CN3110300000000|Keya Paha County, NE
F|CN3110500000000|Kimball County, NE
F|CN3110700000000|Knox County, NE
F|CN3110900000000|Lancaster County, NE
F|CN3111100000000|Lincoln County, NE
F|CN3111300000000|Logan County, NE
F|CN3111500000000|Loup County, NE
F|CN3111700000000|McPherson County, NE
F|CN3111900000000|Madison County, NE
F|CN3112100000000|Merrick County, NE
F|CN3112300000000|Morrill County, NE
F|CN3112500000000|Nance County, NE
F|CN3112700000000|Nemaha County, NE
F|CN3112900000000|Nuckolls County, NE
F|CN3113100000000|Otoe County, NE
F|CN3113300000000|Pawnee County, NE
F|CN3113500000000|Perkins County, NE
F|CN3113700000000|Phelps County, NE
F|CN3113900000000|Pierce County, NE
F|CN3114100000000|Platte County, NE
F|CN3114300000000|Polk County, NE
F|CN3114500000000|Red Willow County, NE
F|CN3114700000000|Richardson County, NE
F|CN3114900000000|Rock County, NE
F|CN3115100000000|Saline County, NE
F|CN3115300000000|Sarpy County, NE
F|CN3115500000000|Saunders County, NE
F|CN3115700000000|Scotts Bluff County, NE
F|CN3115900000000|Seward County, NE
F|CN3116100000000|Sheridan County, NE
F|CN3116300000000|Sherman County, NE
F|CN3116500000000|Sioux County, NE
F|CN3116700000000|Stanton County, NE
F|CN3116900000000|Thayer County, NE
F|CN3117100000000|Thomas County, NE
F|CN3117300000000|Thurston County, NE
F|CN3117500000000|Valley County, NE
F|CN3117700000000|Washington County, NE
F|CN3117900000000|Wayne County, NE
F|CN3118100000000|Webster County, NE
F|CN3118300000000|Wheeler County, NE
F|CN3118500000000|York County, NE
F|CN3200100000000|Churchill County, NV
F|CN3200300000000|Clark County, NV
F|CN3200500000000|Douglas County, NV
F|CN3200700000000|Elko County, NV
F|CN3200900000000|Esmeralda County, NV
F|CN3201100000000|Eureka County, NV
F|CN3201300000000|Humboldt County, NV
F|CN3201500000000|Lander County, NV
F|CN3201700000000|Lincoln County, NV
F|CN3201900000000|Lyon County, NV
F|CN3202100000000|Mineral County, NV
F|CN3202300000000|Nye County, NV
F|CN3202700000000|Pershing County, NV
F|CN3202900000000|Storey County, NV
F|CN3203100000000|Washoe County, NV
F|CN3203300000000|White Pine County, NV
F|CN3251000000000|Carson City, NV
F|CN3300100000000|Belknap County, NH
F|CN3300300000000|Carroll County, NH
F|CN3300500000000|Cheshire County, NH
F|CN3300700000000|Coos County, NH
F|CN3300900000000|Grafton County, NH
F|CN3301100000000|Hillsborough County, NH
F|CN3301300000000|Merrimack County, NH
F|CN3301500000000|Rockingham County, NH
F|CN3301700000000|Strafford County, NH
F|CN3301900000000|Sullivan County, NH
F|CN3400100000000|Atlantic County, NJ
F|CN3400300000000|Bergen County, NJ
F|CN3400500000000|Burlington County, NJ
F|CN3400700000000|Camden County, NJ
F|CN3400900000000|Cape May County, NJ
F|CN3401100000000|Cumberland County, NJ
F|CN3401300000000|Essex County, NJ
F|CN3401500000000|Gloucester County, NJ
F|CN3401700000000|Hudson County, NJ
F|CN3401900000000|Hunterdon County, NJ
F|CN3402100000000|Mercer County, NJ
F|CN3402300000000|Middlesex County, NJ
F|CN3402500000000|Monmouth County, NJ
F|CN3402700000000|Morris County, NJ
F|CN3402900000000|Ocean County, NJ
F|CN3403100000000|Passaic County, NJ
F|CN3403300000000|Salem County, NJ
F|CN3403500000000|Somerset County, NJ
F|CN3403700000000|Sussex County, NJ
F|CN3403900000000|Union County, NJ
F|CN3404100000000|Warren County, NJ
F|CN3500100000000|Bernalillo County, NM
F|CN3500300000000|Catron County, NM
F|CN3500500000000|Chaves County, NM
F|CN3500600000000|Cibola County, NM
F|CN3500700000000|Colfax County, NM
F|CN3500900000000|Curry County, NM
F|CN3501100000000|De Baca County, NM
F|CN3501300000000|Dona Ana County, NM
F|CN3501500000000|Eddy County, NM
F|CN3501700000000|Grant County, NM
F|CN3501900000000|Guadalupe County, NM
F|CN3502100000000|Harding County, NM
F|CN3502300000000|Hidalgo County, NM
F|CN3502500000000|Lea County, NM
F|CN3502700000000|Lincoln County, NM
F|CN3502800000000|Los Alamos County, NM
F|CN3502900000000|Luna County, NM
F|CN3503100000000|McKinley County, NM
F|CN3503300000000|Mora County, NM
F|CN3503500000000|Otero County, NM
F|CN3503700000000|Quay County, NM
F|CN3503900000000|Rio Arriba County, NM
F|CN3504100000000|Roosevelt County, NM
F|CN3504300000000|Sandoval County, NM
F|CN3504500000000|San Juan County, NM
F|CN3504700000000|San Miguel County, NM
F|CN3504900000000|Santa Fe County, NM
F|CN3505100000000|Sierra County, NM
F|CN3505300000000|Socorro County, NM
F|CN3505500000000|Taos County, NM
F|CN3505700000000|Torrance County, NM
F|CN3505900000000|Union County, NM
F|CN3506100000000|Valencia County, NM
F|CN3600100000000|Albany County, NY
F|CN3600300000000|Allegany County, NY
F|CN3600500000000|Bronx County, NY
F|CN3600700000000|Broome County, NY
F|CN3600900000000|Cattaraugus County, NY
F|CN3601100000000|Cayuga County, NY
F|CN3601300000000|Chautauqua County, NY
F|CN3601500000000|Chemung County, NY
F|CN3601700000000|Chenango County, NY
F|CN3601900000000|Clinton County, NY
F|CN3602100000000|Columbia County, NY
F|CN3602300000000|Cortland County, NY
F|CN3602500000000|Delaware County, NY
F|CN3602700000000|Dutchess County, NY
F|CN3602900000000|Erie County, NY
F|CN3603100000000|Essex County, NY
F|CN3603300000000|Franklin County, NY
F|CN3603500000000|Fulton County, NY
F|CN3603700000000|Genesee County, NY
F|CN3603900000000|Greene County, NY
F|CN3604100000000|Hamilton County, NY
F|CN3604300000000|Herkimer County, NY
F|CN3604500000000|Jefferson County, NY
F|CN3604700000000|Kings County, NY
F|CN3604900000000|Lewis County, NY
F|CN3605100000000|Livingston County, NY
F|CN3605300000000|Madison County, NY
F|CN3605500000000|Monroe County, NY
F|CN3605700000000|Montgomery County, NY
F|CN3605900000000|Nassau County, NY
F|CN3606100000000|New York County, NY
F|CN3606300000000|Niagara County, NY
F|CN3606500000000|Oneida County, NY
F|CN3606700000000|Onondaga County, NY
F|CN3606900000000|Ontario County, NY
F|CN3607100000000|Orange County, NY
F|CN3607300000000|Orleans County, NY
F|CN3607500000000|Oswego County, NY
F|CN3607700000000|Otsego County, NY
F|CN3607900000000|Putnam County, NY
F|CN3608100000000|Queens County, NY
F|CN3608300000000|Rensselaer County, NY
F|CN3608500000000|Richmond County, NY
F|CN3608700000000|Rockland County, NY
F|CN3608900000000|St. Lawrence County, NY
F|CN3609100000000|Saratoga County, NY
F|CN3609300000000|Schenectady County, NY
F|CN3609500000000|Schoharie County, NY
F|CN3609700000000|Schuyler County, NY
F|CN3609900000000|Seneca County, NY
F|CN3610100000000|Steuben County, NY
F|CN3610300000000|Suffolk County, NY
F|CN3610500000000|Sullivan County, NY
F|CN3610700000000|Tioga County, NY
F|CN3610900000000|Tompkins County, NY
F|CN3611100000000|Ulster County, NY
F|CN3611300000000|Warren County, NY
F|CN3611500000000|Washington County, NY
F|CN3611700000000|Wayne County, NY
F|CN3611900000000|Westchester County, NY
F|CN3612100000000|Wyoming County, NY
F|CN3612300000000|Yates County, NY
F|CN3700100000000|Alamance County, NC
F|CN3700300000000|Alexander County, NC
F|CN3700500000000|Alleghany County, NC
F|CN3700700000000|Anson County, NC
F|CN3700900000000|Ashe County, NC
F|CN3701100000000|Avery County, NC
F|CN3701300000000|Beaufort County, NC
F|CN3701500000000|Bertie County, NC
F|CN3701700000000|Bladen County, NC
F|CN3701900000000|Brunswick County, NC
F|CN3702100000000|Buncombe County, NC
F|CN3702300000000|Burke County, NC
F|CN3702500000000|Cabarrus County, NC
F|CN3702700000000|Caldwell County, NC
F|CN3702900000000|Camden County, NC
F|CN3703100000000|Carteret County, NC
F|CN3703300000000|Caswell County, NC
F|CN3703500000000|Catawba County, NC
F|CN3703700000000|Chatham County, NC
F|CN3703900000000|Cherokee County, NC
F|CN3704100000000|Chowan County, NC
F|CN3704300000000|Clay County, NC
F|CN3704500000000|Cleveland County, NC
F|CN3704700000000|Columbus County, NC
F|CN3704900000000|Craven County, NC
F|CN3705100000000|Cumberland County, NC
F|CN3705300000000|Currituck County, NC
F|CN3705500000000|Dare County, NC
F|CN3705700000000|Davidson County, NC
F|CN3705900000000|Davie County, NC
F|CN3706100000000|Duplin County, NC
F|CN3706300000000|Durham County, NC
F|CN3706500000000|Edgecombe County, NC
F|CN3706700000000|Forsyth County, NC
F|CN3706900000000|Franklin County, NC
F|CN3707100000000|Gaston County, NC
F|CN3707300000000|Gates County, NC
F|CN3707500000000|Graham County, NC
F|CN3707700000000|Granville County, NC
F|CN3707900000000|Greene County, NC
F|CN3708100000000|Guilford County, NC
F|CN3708300000000|Halifax County, NC
F|CN3708500000000|Harnett County, NC
F|CN3708700000000|Haywood County, NC
F|CN3708900000000|Henderson County, NC
F|CN3709100000000|Hertford County, NC
F|CN3709300000000|Hoke County, NC
F|CN3709500000000|Hyde County, NC
F|CN3709700000000|Iredell County, NC
F|CN3709900000000|Jackson County, NC
F|CN3710100000000|Johnston County, NC
F|CN3710300000000|Jones County, NC
F|CN3710500000000|Lee County, NC
F|CN3710700000000|Lenoir County, NC
F|CN3710900000000|Lincoln County, NC
F|CN3711100000000|McDowell County, NC
F|CN3711300000000|Macon County, NC
F|CN3711500000000|Madison County, NC
F|CN3711700000000|Martin County, NC
F|CN3711900000000|Mecklenburg County, NC
F|CN3712100000000|Mitchell County, NC
F|CN3712300000000|Montgomery County, NC
F|CN3712500000000|Moore County, NC
F|CN3712700000000|Nash County, NC
F|CN3712900000000|New Hanover County, NC
F|CN3713100000000|Northampton County, NC
F|CN3713300000000|Onslow County, NC
F|CN3713500000000|Orange County, NC
F|CN3713700000000|Pamlico County, NC
F|CN3713900000000|Pasquotank County, NC
F|CN3714100000000|Pender County, NC
F|CN3714300000000|Perquimans County, NC
F|CN3714500000000|Person County, NC
F|CN3714700000000|Pitt County, NC
F|CN3714900000000|Polk County, NC
F|CN3715100000000|Randolph County, NC
F|CN3715300000000|Richmond County, NC
F|CN3715500000000|Robeson County, NC
F|CN3715700000000|Rockingham County, NC
F|CN3715900000000|Rowan County, NC
F|CN3716100000000|Rutherford County, NC
F|CN3716300000000|Sampson County, NC
F|CN3716500000000|Scotland County, NC
F|CN3716700000000|Stanly County, NC
F|CN3716900000000|Stokes County, NC
F|CN3717100000000|Surry County, NC
F|CN3717300000000|Swain County, NC
F|CN3717500000000|Transylvania County, NC
F|CN3717700000000|Tyrrell County, NC
F|CN3717900000000|Union County, NC
F|CN3718100000000|Vance County, NC
F|CN3718300000000|Wake County, NC
F|CN3718500000000|Warren County, NC
F|CN3718700000000|Washington County, NC
F|CN3718900000000|Watauga County, NC
F|CN3719100000000|Wayne County, NC
F|CN3719300000000|Wilkes County, NC
F|CN3719500000000|Wilson County, NC
F|CN3719700000000|Yadkin County, NC
F|CN3719900000000|Yancey County, NC
F|CN3800100000000|Adams County, ND
F|CN3800300000000|Barnes County, ND
F|CN3800500000000|Benson County, ND
F|CN3800700000000|Billings County, ND
F|CN3800900000000|Bottineau County, ND
F|CN3801100000000|Bowman County, ND
F|CN3801300000000|Burke County, ND
F|CN3801500000000|Burleigh County, ND
F|CN3801700000000|Cass County, ND
F|CN3801900000000|Cavalier County, ND
F|CN3802100000000|Dickey County, ND
F|CN3802300000000|Divide County, ND
F|CN3802500000000|Dunn County, ND
F|CN3802700000000|Eddy County, ND
F|CN3802900000000|Emmons County, ND
F|CN3803100000000|Foster County, ND
F|CN3803300000000|Golden Valley County, ND
F|CN3803500000000|Grand Forks County, ND
F|CN3803700000000|Grant County, ND
F|CN3803900000000|Griggs County, ND
F|CN3804100000000|Hettinger County, ND
F|CN3804300000000|Kidder County, ND
F|CN3804500000000|LaMoure County, ND
F|CN3804700000000|Logan County, ND
F|CN3804900000000|McHenry County, ND
F|CN3805100000000|McIntosh County, ND
F|CN3805300000000|McKenzie County, ND
F|CN3805500000000|McLean County, ND
F|CN3805700000000|Mercer County, ND
F|CN3805900000000|Morton County, ND
F|CN3806100000000|Mountrail County, ND
F|CN3806300000000|Nelson County, ND
F|CN3806500000000|Oliver County, ND
F|CN3806700000000|Pembina County, ND
F|CN3806900000000|Pierce County, ND
F|CN3807100000000|Ramsey County, ND
F|CN3807300000000|Ransom County, ND
F|CN3807500000000|Renville County, ND
F|CN3807700000000|Richland County, ND
F|CN3807900000000|Rolette County, ND
F|CN3808100000000|Sargent County, ND
F|CN3808300000000|Sheridan County, ND
F|CN3808500000000|Sioux County, ND
F|CN3808700000000|Slope County, ND
F|CN3808900000000|Stark County, ND
F|CN3809100000000|Steele County, ND
F|CN3809300000000|Stutsman County, ND
F|CN3809500000000|Towner County, ND
F|CN3809700000000|Traill County, ND
F|CN3809900000000|Walsh County, ND
F|CN3810100000000|Ward County, ND
F|CN3810300000000|Wells County, ND
F|CN3810500000000|Williams County, ND
F|CN3900100000000|Adams County, OH
F|CN3900300000000|Allen County, OH
F|CN3900500000000|Ashland County, OH
F|CN3900700000000|Ashtabula County, OH
F|CN3900900000000|Athens County, OH
F|CN3901100000000|Auglaize County, OH
F|CN3901300000000|Belmont County, OH
F|CN3901500000000|Brown County, OH
F|CN3901700000000|Butler County, OH
F|CN3901900000000|Carroll County, OH
F|CN3902100000000|Champaign County, OH
F|CN3902300000000|Clark County, OH
F|CN3902500000000|Clermont County, OH
F|CN3902700000000|Clinton County, OH
F|CN3902900000000|Columbiana County, OH
F|CN3903100000000|Coshocton County, OH
F|CN3903300000000|Crawford County, OH
F|CN3903500000000|Cuyahoga County, OH
F|CN3903700000000|Darke County, OH
F|CN3903900000000|Defiance County, OH
F|CN3904100000000|Delaware County, OH
F|CN3904300000000|Erie County, OH
F|CN3904500000000|Fairfield County, OH
F|CN3904700000000|Fayette County, OH
F|CN3904900000000|Franklin County, OH
F|CN3905100000000|Fulton County, OH
F|CN3905300000000|Gallia County, OH
F|CN3905500000000|Geauga County, OH
F|CN3905700000000|Greene County, OH
F|CN3905900000000|Guernsey County, OH
F|CN3906100000000|Hamilton County, OH
F|CN3906300000000|Hancock County, OH
F|CN3906500000000|Hardin County, OH
F|CN3906700000000|Harrison County, OH
F|CN3906900000000|Henry County, OH
F|CN3907100000000|Highland County, OH
F|CN3907300000000|Hocking County, OH
F|CN3907500000000|Holmes County, OH
F|CN3907700000000|Huron County, OH
F|CN3907900000000|Jackson County, OH
F|CN3908100000000|Jefferson County, OH
F|CN3908300000000|Knox County, OH
F|CN3908500000000|Lake County, OH
F|CN3908700000000|Lawrence County, OH
F|CN3908900000000|Licking County, OH
F|CN3909100000000|Logan County, OH
F|CN3909300000000|Lorain County, OH
F|CN3909500000000|Lucas County, OH
F|CN3909700000000|Madison County, OH
F|CN3909900000000|Mahoning County, OH
F|CN3910100000000|Marion County, OH
F|CN3910300000000|Medina County, OH
F|CN3910500000000|Meigs County, OH
F|CN3910700000000|Mercer County, OH
F|CN3910900000000|Miami County, OH
F|CN3911100000000|Monroe County, OH
F|CN3911300000000|Montgomery County, OH
F|CN3911500000000|Morgan County, OH
F|CN3911700000000|Morrow County, OH
F|CN3911900000000|Muskingum County, OH
F|CN3912100000000|Noble County, OH
F|CN3912300000000|Ottawa County, OH
F|CN3912500000000|Paulding County, OH
F|CN3912700000000|Perry County, OH
F|CN3912900000000|Pickaway County, OH
F|CN3913100000000|Pike County, OH
F|CN3913300000000|Portage County, OH
F|CN3913500000000|Preble County, OH
F|CN3913700000000|Putnam County, OH
F|CN3913900000000|Richland County, OH
F|CN3914100000000|Ross County, OH
F|CN3914300000000|Sandusky County, OH
F|CN3914500000000|Scioto County, OH
F|CN3914700000000|Seneca County, OH
F|CN3914900000000|Shelby County, OH
F|CN3915100000000|Stark County, OH
F|CN3915300000000|Summit County, OH
F|CN3915500000000|Trumbull County, OH
F|CN3915700000000|Tuscarawas County, OH
F|CN3915900000000|Union County, OH
F|CN3916100000000|Van Wert County, OH
F|CN3916300000000|Vinton County, OH
F|CN3916500000000|Warren County, OH
F|CN3916700000000|Washington County, OH
F|CN3916900000000|Wayne County, OH
F|CN3917100000000|Williams County, OH
F|CN3917300000000|Wood County, OH
F|CN3917500000000|Wyandot County, OH
F|CN4000100000000|Adair County, OK
F|CN4000300000000|Alfalfa County, OK
F|CN4000500000000|Atoka County, OK
F|CN4000700000000|Beaver County, OK
F|CN4000900000000|Beckham County, OK
F|CN4001100000000|Blaine County, OK
F|CN4001300000000|Bryan County, OK
F|CN4001500000000|Caddo County, OK
F|CN4001700000000|Canadian County, OK
F|CN4001900000000|Carter County, OK
F|CN4002100000000|Cherokee County, OK
F|CN4002300000000|Choctaw County, OK
F|CN4002500000000|Cimarron County, OK
F|CN4002700000000|Cleveland County, OK
F|CN4002900000000|Coal County, OK
F|CN4003100000000|Comanche County, OK
F|CN4003300000000|Cotton County, OK
F|CN4003500000000|Craig County, OK
F|CN4003700000000|Creek County, OK
F|CN4003900000000|Custer County, OK
F|CN4004100000000|Delaware County, OK
F|CN4004300000000|Dewey County, OK
F|CN4004500000000|Ellis County, OK
F|CN4004700000000|Garfield County, OK
F|CN4004900000000|Garvin County, OK
F|CN4005100000000|Grady County, OK
F|CN4005300000000|Grant County, OK
F|CN4005500000000|Greer County, OK
F|CN4005700000000|Harmon County, OK
F|CN4005900000000|Harper County, OK
F|CN4006100000000|Haskell County, OK
F|CN4006300000000|Hughes County, OK
F|CN4006500000000|Jackson County, OK
F|CN4006700000000|Jefferson County, OK
F|CN4006900000000|Johnston County, OK
F|CN4007100000000|Kay County, OK
F|CN4007300000000|Kingfisher County, OK
F|CN4007500000000|Kiowa County, OK
F|CN4007700000000|Latimer County, OK
F|CN4007900000000|Le Flore County, OK
F|CN4008100000000|Lincoln County, OK
F|CN4008300000000|Logan County, OK
F|CN4008500000000|Love County, OK
F|CN4008700000000|McClain County, OK
F|CN4008900000000|McCurtain County, OK
F|CN4009100000000|McIntosh County, OK
F|CN4009300000000|Major County, OK
F|CN4009500000000|Marshall County, OK
F|CN4009700000000|Mayes County, OK
F|CN4009900000000|Murray County, OK
F|CN4010100000000|Muskogee County, OK
F|CN4010300000000|Noble County, OK
F|CN4010500000000|Nowata County, OK
F|CN4010700000000|Okfuskee County, OK
F|CN4010900000000|Oklahoma County, OK
F|CN4011100000000|Okmulgee County, OK
F|CN4011300000000|Osage County, OK
F|CN4011500000000|Ottawa County, OK
F|CN4011700000000|Pawnee County, OK
F|CN4011900000000|Payne County, OK
F|CN4012100000000|Pittsburg County, OK
F|CN4012300000000|Pontotoc County, OK
F|CN4012500000000|Pottawatomie County, OK
F|CN4012700000000|Pushmataha County, OK
F|CN4012900000000|Roger Mills County, OK
F|CN4013100000000|Rogers County, OK
F|CN4013300000000|Seminole County, OK
F|CN4013500000000|Sequoyah County, OK
F|CN4013700000000|Stephens County, OK
F|CN4013900000000|Texas County, OK
F|CN4014100000000|Tillman County, OK
F|CN4014300000000|Tulsa County, OK
F|CN4014500000000|Wagoner County, OK
F|CN4014700000000|Washington County, OK
F|CN4014900000000|Washita County, OK
F|CN4015100000000|Woods County, OK
F|CN4015300000000|Woodward County, OK
F|CN4100100000000|Baker County, OR
F|CN4100300000000|Benton County, OR
F|CN4100500000000|Clackamas County, OR
F|CN4100700000000|Clatsop County, OR
F|CN4100900000000|Columbia County, OR
F|CN4101100000000|Coos County, OR
F|CN4101300000000|Crook County, OR
F|CN4101500000000|Curry County, OR
F|CN4101700000000|Deschutes County, OR
F|CN4101900000000|Douglas County, OR
F|CN4102100000000|Gilliam County, OR
F|CN4102300000000|Grant County, OR
F|CN4102500000000|Harney County, OR
F|CN4102700000000|Hood River County, OR
F|CN4102900000000|Jackson County, OR
F|CN4103100000000|Jefferson County, OR
F|CN4103300000000|Josephine County, OR
F|CN4103500000000|Klamath County, OR
F|CN4103700000000|Lake County, OR
F|CN4103900000000|Lane County, OR
F|CN4104100000000|Lincoln County, OR
F|CN4104300000000|Linn County, OR
F|CN4104500000000|Malheur County, OR
F|CN4104700000000|Marion County, OR
F|CN4104900000000|Morrow County, OR
F|CN4105100000000|Multnomah County, OR
F|CN4105300000000|Polk County, OR
F|CN4105500000000|Sherman County, OR
F|CN4105700000000|Tillamook County, OR
F|CN4105900000000|Umatilla County, OR
F|CN4106100000000|Union County, OR
F|CN4106300000000|Wallowa County, OR
F|CN4106500000000|Wasco County, OR
F|CN4106700000000|Washington County, OR
F|CN4106900000000|Wheeler County, OR
F|CN4107100000000|Yamhill County, OR
F|CN4200100000000|Adams County, PA
F|CN4200300000000|Allegheny County, PA
F|CN4200500000000|Armstrong County, PA
F|CN4200700000000|Beaver County, PA
F|CN4200900000000|Bedford County, PA
F|CN4201100000000|Berks County, PA
F|CN4201300000000|Blair County, PA
F|CN4201500000000|Bradford County, PA
F|CN4201700000000|Bucks County, PA
F|CN4201900000000|Butler County, PA
F|CN4202100000000|Cambria County, PA
F|CN4202300000000|Cameron County, PA
F|CN4202500000000|Carbon County, PA
F|CN4202700000000|Centre County, PA
F|CN4202900000000|Chester County, PA
F|CN4203100000000|Clarion County, PA
F|CN4203300000000|Clearfield County, PA
F|CN4203500000000|Clinton County, PA
F|CN4203700000000|Columbia County, PA
F|CN4203900000000|Crawford County, PA
F|CN4204100000000|Cumberland County, PA
F|CN4204300000000|Dauphin County, PA
F|CN4204500000000|Delaware County, PA
F|CN4204700000000|Elk County, PA
F|CN4204900000000|Erie County, PA
F|CN4205100000000|Fayette County, PA
F|CN4205300000000|Forest County, PA
F|CN4205500000000|Franklin County, PA
F|CN4205700000000|Fulton County, PA
F|CN4205900000000|Greene County, PA
F|CN4206100000000|Huntingdon County, PA
F|CN4206300000000|Indiana County, PA
F|CN4206500000000|Jefferson County, PA
F|CN4206700000000|Juniata County, PA
F|CN4206900000000|Lackawanna County, PA
F|CN4207100000000|Lancaster County, PA
F|CN4207300000000|Lawrence County, PA
F|CN4207500000000|Lebanon County, PA
F|CN4207700000000|Lehigh County, PA
F|CN4207900000000|Luzerne County, PA
F|CN4208100000000|Lycoming County, PA
F|CN4208300000000|McKean County, PA
F|CN4208500000000|Mercer County, PA
F|CN4208700000000|Mifflin County, PA
F|CN4208900000000|Monroe County, PA
F|CN4209100000000|Montgomery County, PA
F|CN4209300000000|Montour County, PA
F|CN4209500000000|Northampton County, PA
F|CN4209700000000|Northumberland County, PA
F|CN4209900000000|Perry County, PA
F|CN4210100000000|Philadelphia County/city, PA
F|CN4210300000000|Pike County, PA
F|CN4210500000000|Potter County, PA
F|CN4210700000000|Schuylkill County, PA
F|CN4210900000000|Snyder County, PA
F|CN4211100000000|Somerset County, PA
F|CN4211300000000|Sullivan County, PA
F|CN4211500000000|Susquehanna County, PA
F|CN4211700000000|Tioga County, PA
F|CN4211900000000|Union County, PA
F|CN4212100000000|Venango County, PA
F|CN4212300000000|Warren County, PA
F|CN4212500000000|Washington County, PA
F|CN4212700000000|Wayne County, PA
F|CN4212900000000|Westmoreland County, PA
F|CN4213100000000|Wyoming County, PA
F|CN4213300000000|York County, PA
F|CN4400100000000|Bristol County, RI
F|CN4400300000000|Kent County, RI
F|CN4400500000000|Newport County, RI
F|CN4400700000000|Providence County, RI
F|CN4400900000000|Washington County, RI
F|CN4500100000000|Abbeville County, SC
F|CN4500300000000|Aiken County, SC
F|CN4500500000000|Allendale County, SC
F|CN4500700000000|Anderson County, SC
F|CN4500900000000|Bamberg County, SC
F|CN4501100000000|Barnwell County, SC
F|CN4501300000000|Beaufort County, SC
F|CN4501500000000|Berkeley County, SC
F|CN4501700000000|Calhoun County, SC
F|CN4501900000000|Charleston County, SC
F|CN4502100000000|Cherokee County, SC
F|CN4502300000000|Chester County, SC
F|CN4502500000000|Chesterfield County, SC
F|CN4502700000000|Clarendon County, SC
F|CN4502900000000|Colleton County, SC
F|CN4503100000000|Darlington County, SC
F|CN4503300000000|Dillon County, SC
F|CN4503500000000|Dorchester County, SC
F|CN4503700000000|Edgefield County, SC
F|CN4503900000000|Fairfield County, SC
F|CN4504100000000|Florence County, SC
F|CN4504300000000|Georgetown County, SC
F|CN4504500000000|Greenville County, SC
F|CN4504700000000|Greenwood County, SC
F|CN4504900000000|Hampton County, SC
F|CN4505100000000|Horry County, SC
F|CN4505300000000|Jasper County, SC
F|CN4505500000000|Kershaw County, SC
F|CN4505700000000|Lancaster County, SC
F|CN4505900000000|Laurens County, SC
F|CN4506100000000|Lee County, SC
F|CN4506300000000|Lexington County, SC
F|CN4506500000000|McCormick County, SC
F|CN4506700000000|Marion County, SC
F|CN4506900000000|Marlboro County, SC
F|CN4507100000000|Newberry County, SC
F|CN4507300000000|Oconee County, SC
F|CN4507500000000|Orangeburg County, SC
F|CN4507700000000|Pickens County, SC
F|CN4507900000000|Richland County, SC
F|CN4508100000000|Saluda County, SC
F|CN4508300000000|Spartanburg County, SC
F|CN4508500000000|Sumter County, SC
F|CN4508700000000|Union County, SC
F|CN4508900000000|Williamsburg County, SC
F|CN4509100000000|York County, SC
F|CN4600300000000|Aurora County, SD
F|CN4600500000000|Beadle County, SD
F|CN4600700000000|Bennett County, SD
F|CN4600900000000|Bon Homme County, SD
F|CN4601100000000|Brookings County, SD
F|CN4601300000000|Brown County, SD
F|CN4601500000000|Brule County, SD
F|CN4601700000000|Buffalo County, SD
F|CN4601900000000|Butte County, SD
F|CN4602100000000|Campbell County, SD
F|CN4602300000000|Charles Mix County, SD
F|CN4602500000000|Clark County, SD
F|CN4602700000000|Clay County, SD
F|CN4602900000000|Codington County, SD
F|CN4603100000000|Corson County, SD
F|CN4603300000000|Custer County, SD
F|CN4603500000000|Davison County, SD
F|CN4603700000000|Day County, SD
F|CN4603900000000|Deuel County, SD
F|CN4604100000000|Dewey County, SD
F|CN4604300000000|Douglas County, SD
F|CN4604500000000|Edmunds County, SD
F|CN4604700000000|Fall River County, SD
F|CN4604900000000|Faulk County, SD
F|CN4605100000000|Grant County, SD
F|CN4605300000000|Gregory County, SD
F|CN4605500000000|Haakon County, SD
F|CN4605700000000|Hamlin County, SD
F|CN4605900000000|Hand County, SD
F|CN4606100000000|Hanson County, SD
F|CN4606300000000|Harding County, SD
F|CN4606500000000|Hughes County, SD
F|CN4606700000000|Hutchinson County, SD
F|CN4606900000000|Hyde County, SD
F|CN4607100000000|Jackson County, SD
F|CN4607300000000|Jerauld County, SD
F|CN4607500000000|Jones County, SD
F|CN4607700000000|Kingsbury County, SD
F|CN4607900000000|Lake County, SD
F|CN4608100000000|Lawrence County, SD
F|CN4608300000000|Lincoln County, SD
F|CN4608500000000|Lyman County, SD
F|CN4608700000000|McCook County, SD
F|CN4608900000000|McPherson County, SD
F|CN4609100000000|Marshall County, SD
F|CN4609300000000|Meade County, SD
F|CN4609500000000|Mellette County, SD
F|CN4609700000000|Miner County, SD
F|CN4609900000000|Minnehaha County, SD
F|CN4610100000000|Moody County, SD
F|CN4610200000000|Oglala Lakota County, SD
F|CN4610300000000|Pennington County, SD
F|CN4610500000000|Perkins County, SD
F|CN4610700000000|Potter County, SD
F|CN4610900000000|Roberts County, SD
F|CN4611100000000|Sanborn County, SD
F|CN4611500000000|Spink County, SD
F|CN4611700000000|Stanley County, SD
F|CN4611900000000|Sully County, SD
F|CN4612100000000|Todd County, SD
F|CN4612300000000|Tripp County, SD
F|CN4612500000000|Turner County, SD
F|CN4612700000000|Union County, SD
F|CN4612900000000|Walworth County, SD
F|CN4613500000000|Yankton County, SD
F|CN4613700000000|Ziebach County, SD
F|CN4700100000000|Anderson County, TN
F|CN4700300000000|Bedford County, TN
F|CN4700500000000|Benton County, TN
F|CN4700700000000|Bledsoe County, TN
F|CN4700900000000|Blount County, TN
F|CN4701100000000|Bradley County, TN
F|CN4701300000000|Campbell County, TN
F|CN4701500000000|Cannon County, TN
F|CN4701700000000|Carroll County, TN
F|CN4701900000000|Carter County, TN
F|CN4702100000000|Cheatham County, TN
F|CN4702300000000|Chester County, TN
F|CN4702500000000|Claiborne County, TN
F|CN4702700000000|Clay County, TN
F|CN4702900000000|Cocke County, TN
F|CN4703100000000|Coffee County, TN
F|CN4703300000000|Crockett County, TN
F|CN4703500000000|Cumberland County, TN
F|CN4703700000000|Davidson County, TN
F|CN4703900000000|Decatur County, TN
F|CN4704100000000|DeKalb County, TN
F|CN4704300000000|Dickson County, TN
F|CN4704500000000|Dyer County, TN
F|CN4704700000000|Fayette County, TN
F|CN4704900000000|Fentress County, TN
F|CN4705100000000|Franklin County, TN
F|CN4705300000000|Gibson County, TN
F|CN4705500000000|Giles County, TN
F|CN4705700000000|Grainger County, TN
F|CN4705900000000|Greene County, TN
F|CN4706100000000|Grundy County, TN
F|CN4706300000000|Hamblen County, TN
F|CN4706500000000|Hamilton County, TN
F|CN4706700000000|Hancock County, TN
F|CN4706900000000|Hardeman County, TN
F|CN4707100000000|Hardin County, TN
F|CN4707300000000|Hawkins County, TN
F|CN4707500000000|Haywood County, TN
F|CN4707700000000|Henderson County, TN
F|CN4707900000000|Henry County, TN
F|CN4708100000000|Hickman County, TN
F|CN4708300000000|Houston County, TN
F|CN4708500000000|Humphreys County, TN
F|CN4708700000000|Jackson County, TN
F|CN4708900000000|Jefferson County, TN
F|CN4709100000000|Johnson County, TN
F|CN4709300000000|Knox County, TN
F|CN4709500000000|Lake County, TN
F|CN4709700000000|Lauderdale County, TN
F|CN4709900000000|Lawrence County, TN
F|CN4710100000000|Lewis County, TN
F|CN4710300000000|Lincoln County, TN
F|CN4710500000000|Loudon County, TN
F|CN4710700000000|McMinn County, TN
F|CN4710900000000|McNairy County, TN
F|CN4711100000000|Macon County, TN
F|CN4711300000000|Madison County, TN
F|CN4711500000000|Marion County, TN
F|CN4711700000000|Marshall County, TN
F|CN4711900000000|Maury County, TN
F|CN4712100000000|Meigs County, TN
F|CN4712300000000|Monroe County, TN
F|CN4712500000000|Montgomery County, TN
F|CN4712700000000|Moore County, TN
F|CN4712900000000|Morgan County, TN
F|CN4713100000000|Obion County, TN
F|CN4713300000000|Overton County, TN
F|CN4713500000000|Perry County, TN
F|CN4713700000000|Pickett County, TN
F|CN4713900000000|Polk County, TN
F|CN4714100000000|Putnam County, TN
F|CN4714300000000|Rhea County, TN
F|CN4714500000000|Roane County, TN
F|CN4714700000000|Robertson County, TN
F|CN4714900000000|Rutherford County, TN
F|CN4715100000000|Scott County, TN
F|CN4715300000000|Sequatchie County, TN
F|CN4715500000000|Sevier County, TN
F|CN4715700000000|Shelby County, TN
F|CN4715900000000|Smith County, TN
F|CN4716100000000|Stewart County, TN
F|CN4716300000000|Sullivan County, TN
F|CN4716500000000|Sumner County, TN
F|CN4716700000000|Tipton County, TN
F|CN4716900000000|Trousdale County, TN
F|CN4717100000000|Unicoi County, TN
F|CN4717300000000|Union County, TN
F|CN4717500000000|Van Buren County, TN
F|CN4717700000000|Warren County, TN
F|CN4717900000000|Washington County, TN
F|CN4718100000000|Wayne County, TN
F|CN4718300000000|Weakley County, TN
F|CN4718500000000|White County, TN
F|CN4718700000000|Williamson County, TN
F|CN4718900000000|Wilson County, TN
F|CN4800100000000|Anderson County, TX
F|CN4800300000000|Andrews County, TX
F|CN4800500000000|Angelina County, TX
F|CN4800700000000|Aransas County, TX
F|CN4800900000000|Archer County, TX
F|CN4801100000000|Armstrong County, TX
F|CN4801300000000|Atascosa County, TX
F|CN4801500000000|Austin County, TX
F|CN4801700000000|Bailey County, TX
F|CN4801900000000|Bandera County, TX
F|CN4802100000000|Bastrop County, TX
F|CN4802300000000|Baylor County, TX
F|CN4802500000000|Bee County, TX
F|CN4802700000000|Bell County, TX
F|CN4802900000000|Bexar County, TX
F|CN4803100000000|Blanco County, TX
F|CN4803300000000|Borden County, TX
F|CN4803500000000|Bosque County, TX
F|CN4803700000000|Bowie County, TX
F|CN4803900000000|Brazoria County, TX
F|CN4804100000000|Brazos County, TX
F|CN4804300000000|Brewster County, TX
F|CN4804500000000|Briscoe County, TX
F|CN4804700000000|Brooks County, TX
F|CN4804900000000|Brown County, TX
F|CN4805100000000|Burleson County, TX
F|CN4805300000000|Burnet County, TX
F|CN4805500000000|Caldwell County, TX
F|CN4805700000000|Calhoun County, TX
F|CN4805900000000|Callahan County, TX
F|CN4806100000000|Cameron County, TX
F|CN4806300000000|Camp County, TX
F|CN4806500000000|Carson County, TX
F|CN4806700000000|Cass County, TX
F|CN4806900000000|Castro County, TX
F|CN4807100000000|Chambers County, TX
F|CN4807300000000|Cherokee County, TX
F|CN4807500000000|Childress County, TX
F|CN4807700000000|Clay County, TX
F|CN4807900000000|Cochran County, TX
F|CN4808100000000|Coke County, TX
F|CN4808300000000|Coleman County, TX
F|CN4808500000000|Collin County, TX
F|CN4808700000000|Collingsworth County, TX
F|CN4808900000000|Colorado County, TX
F|CN4809100000000|Comal County, TX
F|CN4809300000000|Comanche County, TX
F|CN4809500000000|Concho County, TX
F|CN4809700000000|Cooke County, TX
F|CN4809900000000|Coryell County, TX
F|CN4810100000000|Cottle County, TX
F|CN4810300000000|Crane County, TX
F|CN4810500000000|Crockett County, TX
F|CN4810700000000|Crosby County, TX
F|CN4810900000000|Culberson County, TX
F|CN4811100000000|Dallam County, TX
F|CN4811300000000|Dallas County, TX
F|CN4811500000000|Dawson County, TX
F|CN4811700000000|Deaf Smith County, TX
F|CN4811900000000|Delta County, TX
F|CN4812100000000|Denton County, TX
F|CN4812300000000|DeWitt County, TX
F|CN4812500000000|Dickens County, TX
F|CN4812700000000|Dimmit County, TX
F|CN4812900000000|Donley County, TX
F|CN4813100000000|Duval County, TX
F|CN4813300000000|Eastland County, TX
F|CN4813500000000|Ector County, TX
F|CN4813700000000|Edwards County, TX
F|CN4813900000000|Ellis County, TX
F|CN4814100000000|El Paso County, TX
F|CN4814300000000|Erath County, TX
F|CN4814500000000|Falls County, TX
F|CN4814700000000|Fannin County, TX
F|CN4814900000000|Fayette County, TX
F|CN4815100000000|Fisher County, TX
F|CN4815300000000|Floyd County, TX
F|CN4815500000000|Foard County, TX
F|CN4815700000000|Fort Bend County, TX
F|CN4815900000000|Franklin County, TX
F|CN4816100000000|Freestone County, TX
F|CN4816300000000|Frio County, TX
F|CN4816500000000|Gaines County, TX
F|CN4816700000000|Galveston County, TX
F|CN4816900000000|Garza County, TX
F|CN4817100000000|Gillespie County, TX
F|CN4817300000000|Glasscock County, TX
F|CN4817500000000|Goliad County, TX
F|CN4817700000000|Gonzales County, TX
F|CN4817900000000|Gray County, TX
F|CN4818100000000|Grayson County, TX
F|CN4818300000000|Gregg County, TX
F|CN4818500000000|Grimes County, TX
F|CN4818700000000|Guadalupe County, TX
F|CN4818900000000|Hale County, TX
F|CN4819100000000|Hall County, TX
F|CN4819300000000|Hamilton County, TX
F|CN4819500000000|Hansford County, TX
F|CN4819700000000|Hardeman County, TX
F|CN4819900000000|Hardin County, TX
F|CN4820100000000|Harris County, TX
F|CN4820300000000|Harrison County, TX
F|CN4820500000000|Hartley County, TX
F|CN4820700000000|Haskell County, TX
F|CN4820900000000|Hays County, TX
F|CN4821100000000|Hemphill County, TX
F|CN4821300000000|Henderson County, TX
F|CN4821500000000|Hidalgo County, TX
F|CN4821700000000|Hill County, TX
F|CN4821900000000|Hockley County, TX
F|CN4822100000000|Hood County, TX
F|CN4822300000000|Hopkins County, TX
F|CN4822500000000|Houston County, TX
F|CN4822700000000|Howard County, TX
F|CN4822900000000|Hudspeth County, TX
F|CN4823100000000|Hunt County, TX
F|CN4823300000000|Hutchinson County, TX
F|CN4823500000000|Irion County, TX
F|CN4823700000000|Jack County, TX
F|CN4823900000000|Jackson County, TX
F|CN4824100000000|Jasper County, TX
F|CN4824300000000|Jeff Davis County, TX
F|CN4824500000000|Jefferson County, TX
F|CN4824700000000|Jim Hogg County, TX
F|CN4824900000000|Jim Wells County, TX
F|CN4825100000000|Johnson County, TX
F|CN4825300000000|Jones County, TX
F|CN4825500000000|Karnes County, TX
F|CN4825700000000|Kaufman County, TX
F|CN4825900000000|Kendall County, TX
F|CN4826100000000|Kenedy County, TX
F|CN4826300000000|Kent County, TX
F|CN4826500000000|Kerr County, TX
F|CN4826700000000|Kimble County, TX
F|CN4826900000000|King County, TX
F|CN4827100000000|Kinney County, TX
F|CN4827300000000|Kleberg County, TX
F|CN4827500000000|Knox County, TX
F|CN4827700000000|Lamar County, TX
F|CN4827900000000|Lamb County, TX
F|CN4828100000000|Lampasas County, TX
F|CN4828300000000|La Salle County, TX
F|CN4828500000000|Lavaca County, TX
F|CN4828700000000|Lee County, TX
F|CN4828900000000|Leon County, TX
F|CN4829100000000|Liberty County, TX
F|CN4829300000000|Limestone County, TX
F|CN4829500000000|Lipscomb County, TX
F|CN4829700000000|Live Oak County, TX
F|CN4829900000000|Llano County, TX
F|CN4830100000000|Loving County, TX
F|CN4830300000000|Lubbock County, TX
F|CN4830500000000|Lynn County, TX
F|CN4830700000000|McCulloch County, TX
F|CN4830900000000|McLennan County, TX
F|CN4831100000000|McMullen County, TX
F|CN4831300000000|Madison County, TX
F|CN4831500000000|Marion County, TX
F|CN4831700000000|Martin County, TX
F|CN4831900000000|Mason County, TX
F|CN4832100000000|Matagorda County, TX
F|CN4832300000000|Maverick County, TX
F|CN4832500000000|Medina County, TX
F|CN4832700000000|Menard County, TX
F|CN4832900000000|Midland County, TX
F|CN4833100000000|Milam County, TX
F|CN4833300000000|Mills County, TX
F|CN4833500000000|Mitchell County, TX
F|CN4833700000000|Montague County, TX
F|CN4833900000000|Montgomery County, TX
F|CN4834100000000|Moore County, TX
F|CN4834300000000|Morris County, TX
F|CN4834500000000|Motley County, TX
F|CN4834700000000|Nacogdoches County, TX
F|CN4834900000000|Navarro County, TX
F|CN4835100000000|Newton County, TX
F|CN4835300000000|Nolan County, TX
F|CN4835500000000|Nueces County, TX
F|CN4835700000000|Ochiltree County, TX
F|CN4835900000000|Oldham County, TX
F|CN4836100000000|Orange County, TX
F|CN4836300000000|Palo Pinto County, TX
F|CN4836500000000|Panola County, TX
F|CN4836700000000|Parker County, TX
F|CN4836900000000|Parmer County, TX
F|CN4837100000000|Pecos County, TX
F|CN4837300000000|Polk County, TX
F|CN4837500000000|Potter County, TX
F|CN4837700000000|Presidio County, TX
F|CN4837900000000|Rains County, TX
F|CN4838100000000|Randall County, TX
F|CN4838300000000|Reagan County, TX
F|CN4838500000000|Real County, TX
F|CN4838700000000|Red River County, TX
F|CN4838900000000|Reeves County, TX
F|CN4839100000000|Refugio County, TX
F|CN4839300000000|Roberts County, TX
F|CN4839500000000|Robertson County, TX
F|CN4839700000000|Rockwall County, TX
F|CN4839900000000|Runnels County, TX
F|CN4840100000000|Rusk County, TX
F|CN4840300000000|Sabine County, TX
F|CN4840500000000|San Augustine County, TX
F|CN4840700000000|San Jacinto County, TX
F|CN4840900000000|San Patricio County, TX
F|CN4841100000000|San Saba County, TX
F|CN4841300000000|Schleicher County, TX
F|CN4841500000000|Scurry County, TX
F|CN4841700000000|Shackelford County, TX
F|CN4841900000000|Shelby County, TX
F|CN4842100000000|Sherman County, TX
F|CN4842300000000|Smith County, TX
F|CN4842500000000|Somervell County, TX
F|CN4842700000000|Starr County, TX
F|CN4842900000000|Stephens County, TX
F|CN4843100000000|Sterling County, TX
F|CN4843300000000|Stonewall County, TX
F|CN4843500000000|Sutton County, TX
F|CN4843700000000|Swisher County, TX
F|CN4843900000000|Tarrant County, TX
F|CN4844100000000|Taylor County, TX
F|CN4844300000000|Terrell County, TX
F|CN4844500000000|Terry County, TX
F|CN4844700000000|Throckmorton County, TX
F|CN4844900000000|Titus County, TX
F|CN4845100000000|Tom Green County, TX
F|CN4845300000000|Travis County, TX
F|CN4845500000000|Trinity County, TX
F|CN4845700000000|Tyler County, TX
F|CN4845900000000|Upshur County, TX
F|CN4846100000000|Upton County, TX
F|CN4846300000000|Uvalde County, TX
F|CN4846500000000|Val Verde County, TX
F|CN4846700000000|Van Zandt County, TX
F|CN4846900000000|Victoria County, TX
F|CN4847100000000|Walker County, TX
F|CN4847300000000|Waller County, TX
F|CN4847500000000|Ward County, TX
F|CN4847700000000|Washington County, TX
F|CN4847900000000|Webb County, TX
F|CN4848100000000|Wharton County, TX
F|CN4848300000000|Wheeler County, TX
F|CN4848500000000|Wichita County, TX
F|CN4848700000000|Wilbarger County, TX
F|CN4848900000000|Willacy County, TX
F|CN4849100000000|Williamson County, TX
F|CN4849300000000|Wilson County, TX
F|CN4849500000000|Winkler County, TX
F|CN4849700000000|Wise County, TX
F|CN4849900000000|Wood County, TX
F|CN4850100000000|Yoakum County, TX
F|CN4850300000000|Young County, TX
F|CN4850500000000|Zapata County, TX
F|CN4850700000000|Zavala County, TX
F|CN4900100000000|Beaver County, UT
F|CN4900300000000|Box Elder County, UT
F|CN4900500000000|Cache County, UT
F|CN4900700000000|Carbon County, UT
F|CN4900900000000|Daggett County, UT
F|CN4901100000000|Davis County, UT
F|CN4901300000000|Duchesne County, UT
F|CN4901500000000|Emery County, UT
F|CN4901700000000|Garfield County, UT
F|CN4901900000000|Grand County, UT
F|CN4902100000000|Iron County, UT
F|CN4902300000000|Juab County, UT
F|CN4902500000000|Kane County, UT
F|CN4902700000000|Millard County, UT
F|CN4902900000000|Morgan County, UT
F|CN4903100000000|Piute County, UT
F|CN4903300000000|Rich County, UT
F|CN4903500000000|Salt Lake County, UT
F|CN4903700000000|San Juan County, UT
F|CN4903900000000|Sanpete County, UT
F|CN4904100000000|Sevier County, UT
F|CN4904300000000|Summit County, UT
F|CN4904500000000|Tooele County, UT
F|CN4904700000000|Uintah County, UT
F|CN4904900000000|Utah County, UT
F|CN4905100000000|Wasatch County, UT
F|CN4905300000000|Washington County, UT
F|CN4905500000000|Wayne County, UT
F|CN4905700000000|Weber County, UT
F|CN5000100000000|Addison County, VT
F|CN5000300000000|Bennington County, VT
F|CN5000500000000|Caledonia County, VT
F|CN5000700000000|Chittenden County, VT
F|CN5000900000000|Essex County, VT
F|CN5001100000000|Franklin County, VT
F|CN5001300000000|Grand Isle County, VT
F|CN5001500000000|Lamoille County, VT
F|CN5001700000000|Orange County, VT
F|CN5001900000000|Orleans County, VT
F|CN5002100000000|Rutland County, VT
F|CN5002300000000|Washington County, VT
F|CN5002500000000|Windham County, VT
F|CN5002700000000|Windsor County, VT
F|CN5100100000000|Accomack County, VA
F|CN5100300000000|Albemarle County, VA
F|CN5100500000000|Alleghany County, VA
F|CN5100700000000|Amelia County, VA
F|CN5100900000000|Amherst County, VA
F|CN5101100000000|Appomattox County, VA
F|CN5101300000000|Arlington County, VA
F|CN5101500000000|Augusta County, VA
F|CN5101700000000|Bath County, VA
F|CN5101900000000|Bedford County, VA
F|CN5102100000000|Bland County, VA
F|CN5102300000000|Botetourt County, VA
F|CN5102500000000|Brunswick County, VA
F|CN5102700000000|Buchanan County, VA
F|CN5102900000000|Buckingham County, VA
F|CN5103100000000|Campbell County, VA
F|CN5103300000000|Caroline County, VA
F|CN5103500000000|Carroll County, VA
F|CN5103600000000|Charles City County, VA
F|CN5103700000000|Charlotte County, VA
F|CN5104100000000|Chesterfield County, VA
F|CN5104300000000|Clarke County, VA
F|CN5104500000000|Craig County, VA
F|CN5104700000000|Culpeper County, VA
F|CN5104900000000|Cumberland County, VA
F|CN5105100000000|Dickenson County, VA
F|CN5105300000000|Dinwiddie County, VA
F|CN5105700000000|Essex County, VA
F|CN5105900000000|Fairfax County, VA
F|CN5106100000000|Fauquier County, VA
F|CN5106300000000|Floyd County, VA
F|CN5106500000000|Fluvanna County, VA
F|CN5106700000000|Franklin County, VA
F|CN5106900000000|Frederick County, VA
F|CN5107100000000|Giles County, VA
F|CN5107300000000|Gloucester County, VA
F|CN5107500000000|Goochland County, VA
F|CN5107700000000|Grayson County, VA
F|CN5107900000000|Greene County, VA
F|CN5108100000000|Greensville County, VA
F|CN5108300000000|Halifax County, VA
F|CN5108500000000|Hanover County, VA
F|CN5108700000000|Henrico County, VA
F|CN5108900000000|Henry County, VA
F|CN5109100000000|Highland County, VA
F|CN5109300000000|Isle of Wight County, VA
F|CN5109500000000|James City County, VA
F|CN5109700000000|King and Queen County, VA
F|CN5109900000000|King George County, VA
F|CN5110100000000|King William County, VA
F|CN5110300000000|Lancaster County, VA
F|CN5110500000000|Lee County, VA
F|CN5110700000000|Loudoun County, VA
F|CN5110900000000|Louisa County, VA
F|CN5111100000000|Lunenburg County, VA
F|CN5111300000000|Madison County, VA
F|CN5111500000000|Mathews County, VA
F|CN5111700000000|Mecklenburg County, VA
F|CN5111900000000|Middlesex County, VA
F|CN5112100000000|Montgomery County, VA
F|CN5112500000000|Nelson County, VA
F|CN5112700000000|New Kent County, VA
F|CN5113100000000|Northampton County, VA
F|CN5113300000000|Northumberland County, VA
F|CN5113500000000|Nottoway County, VA
F|CN5113700000000|Orange County, VA
F|CN5113900000000|Page County, VA
F|CN5114100000000|Patrick County, VA
F|CN5114300000000|Pittsylvania County, VA
F|CN5114500000000|Powhatan County, VA
F|CN5114700000000|Prince Edward County, VA
F|CN5114900000000|Prince George County, VA
F|CN5115300000000|Prince William County, VA
F|CN5115500000000|Pulaski County, VA
F|CN5115700000000|Rappahannock County, VA
F|CN5115900000000|Richmond County, VA
F|CN5116100000000|Roanoke County, VA
F|CN5116300000000|Rockbridge County, VA
F|CN5116500000000|Rockingham County, VA
F|CN5116700000000|Russell County, VA
F|CN5116900000000|Scott County, VA
F|CN5117100000000|Shenandoah County, VA
F|CN5117300000000|Smyth County, VA
F|CN5117500000000|Southampton County, VA
F|CN5117700000000|Spotsylvania County, VA
F|CN5117900000000|Stafford County, VA
F|CN5118100000000|Surry County, VA
F|CN5118300000000|Sussex County, VA
F|CN5118500000000|Tazewell County, VA
F|CN5118700000000|Warren County, VA
F|CN5119100000000|Washington County, VA
F|CN5119300000000|Westmoreland County, VA
F|CN5119500000000|Wise County, VA
F|CN5119700000000|Wythe County, VA
F|CN5119900000000|York County, VA
F|CN5151000000000|Alexandria city, VA
F|CN5152000000000|Bristol city, VA
F|CN5153000000000|Buena Vista city, VA
F|CN5154000000000|Charlottesville city, VA
F|CN5155000000000|Chesapeake city, VA
F|CN5157000000000|Colonial Heights city, VA
F|CN5158000000000|Covington city, VA
F|CN5159000000000|Danville city, VA
F|CN5159500000000|Emporia city, VA
F|CN5160000000000|Fairfax city, VA
F|CN5161000000000|Falls Church city, VA
F|CN5162000000000|Franklin city, VA
F|CN5163000000000|Fredericksburg city, VA
F|CN5164000000000|Galax city, VA
F|CN5165000000000|Hampton city, VA
F|CN5166000000000|Harrisonburg city, VA
F|CN5167000000000|Hopewell city, VA
F|CN5167800000000|Lexington city, VA
F|CN5168000000000|Lynchburg city, VA
F|CN5168300000000|Manassas city, VA
F|CN5168500000000|Manassas Park city, VA
F|CN5169000000000|Martinsville city, VA
F|CN5170000000000|Newport News city, VA
F|CN5171000000000|Norfolk city, VA
F|CN5172000000000|Norton city, VA
F|CN5173000000000|Petersburg city, VA
F|CN5173500000000|Poquoson city, VA
F|CN5174000000000|Portsmouth city, VA
F|CN5175000000000|Radford city, VA
F|CN5176000000000|Richmond city, VA
F|CN5177000000000|Roanoke city, VA
F|CN5177500000000|Salem city, VA
F|CN5179000000000|Staunton city, VA
F|CN5180000000000|Suffolk city, VA
F|CN5181000000000|Virginia Beach city, VA
F|CN5182000000000|Waynesboro city, VA
F|CN5183000000000|Williamsburg city, VA
F|CN5184000000000|Winchester city, VA
F|CN5300100000000|Adams County, WA
F|CN5300300000000|Asotin County, WA
F|CN5300500000000|Benton County, WA
F|CN5300700000000|Chelan County, WA
F|CN5300900000000|Clallam County, WA
F|CN5301100000000|Clark County, WA
F|CN5301300000000|Columbia County, WA
F|CN5301500000000|Cowlitz County, WA
F|CN5301700000000|Douglas County, WA
F|CN5301900000000|Ferry County, WA
F|CN5302100000000|Franklin County, WA
F|CN5302300000000|Garfield County, WA
F|CN5302500000000|Grant County, WA
F|CN5302700000000|Grays Harbor County, WA
F|CN5302900000000|Island County, WA
F|CN5303100000000|Jefferson County, WA
F|CN5303300000000|King County, WA
F|CN5303500000000|Kitsap County, WA
F|CN5303700000000|Kittitas County, WA
F|CN5303900000000|Klickitat County, WA
F|CN5304100000000|Lewis County, WA
F|CN5304300000000|Lincoln County, WA
F|CN5304500000000|Mason County, WA
F|CN5304700000000|Okanogan County, WA
F|CN5304900000000|Pacific County, WA
F|CN5305100000000|Pend Oreille County, WA
F|CN5305300000000|Pierce County, WA
F|CN5305500000000|San Juan County, WA
F|CN5305700000000|Skagit County, WA
F|CN5305900000000|Skamania County, WA
F|CN5306100000000|Snohomish County, WA
F|CN5306300000000|Spokane County, WA
F|CN5306500000000|Stevens County, WA
F|CN5306700000000|Thurston County, WA
F|CN5306900000000|Wahkiakum County, WA
F|CN5307100000000|Walla Walla County, WA
F|CN5307300000000|Whatcom County, WA
F|CN5307500000000|Whitman County, WA
F|CN5307700000000|Yakima County, WA
F|CN5400100000000|Barbour County, WV
F|CN5400300000000|Berkeley County, WV
F|CN5400500000000|Boone County, WV
F|CN5400700000000|Braxton County, WV
F|CN5400900000000|Brooke County, WV
F|CN5401100000000|Cabell County, WV
F|CN5401300000000|Calhoun County, WV
F|CN5401500000000|Clay County, WV
F|CN5401700000000|Doddridge County, WV
F|CN5401900000000|Fayette County, WV
F|CN5402100000000|Gilmer County, WV
F|CN5402300000000|Grant County, WV
F|CN5402500000000|Greenbrier County, WV
F|CN5402700000000|Hampshire County, WV
F|CN5402900000000|Hancock County, WV
F|CN5403100000000|Hardy County, WV
F|CN5403300000000|Harrison County, WV
F|CN5403500000000|Jackson County, WV
F|CN5403700000000|Jefferson County, WV
F|CN5403900000000|Kanawha County, WV
F|CN5404100000000|Lewis County, WV
F|CN5404300000000|Lincoln County, WV
F|CN5404500000000|Logan County, WV
F|CN5404700000000|McDowell County, WV
F|CN5404900000000|Marion County, WV
F|CN5405100000000|Marshall County, WV
F|CN5405300000000|Mason County, WV
F|CN5405500000000|Mercer County, WV
F|CN5405700000000|Mineral County, WV
F|CN5405900000000|Mingo County, WV
F|CN5406100000000|Monongalia County, WV
F|CN5406300000000|Monroe County, WV
F|CN5406500000000|Morgan County, WV
F|CN5406700000000|Nicholas County, WV
F|CN5406900000000|Ohio County, WV
F|CN5407100000000|Pendleton County, WV
F|CN5407300000000|Pleasants County, WV
F|CN5407500000000|Pocahontas County, WV
F|CN5407700000000|Preston County, WV
F|CN5407900000000|Putnam County, WV
F|CN5408100000000|Raleigh County, WV
F|CN5408300000000|Randolph County, WV
F|CN5408500000000|Ritchie County, WV
F|CN5408700000000|Roane County, WV
F|CN5408900000000|Summers County, WV
F|CN5409100000000|Taylor County, WV
F|CN5409300000000|Tucker County, WV
F|CN5409500000000|Tyler County, WV
F|CN5409700000000|Upshur County, WV
F|CN5409900000000|Wayne County, WV
F|CN5410100000000|Webster County, WV
F|CN5410300000000|Wetzel County, WV
F|CN5410500000000|Wirt County, WV
F|CN5410700000000|Wood County, WV
F|CN5410900000000|Wyoming County, WV
F|CN5500100000000|Adams County, WI
F|CN5500300000000|Ashland County, WI
F|CN5500500000000|Barron County, WI
F|CN5500700000000|Bayfield County, WI
F|CN5500900000000|Brown County, WI
F|CN5501100000000|Buffalo County, WI
F|CN5501300000000|Burnett County, WI
F|CN5501500000000|Calumet County, WI
F|CN5501700000000|Chippewa County, WI
F|CN5501900000000|Clark County, WI
F|CN5502100000000|Columbia County, WI
F|CN5502300000000|Crawford County, WI
F|CN5502500000000|Dane County, WI
F|CN5502700000000|Dodge County, WI
F|CN5502900000000|Door County, WI
F|CN5503100000000|Douglas County, WI
F|CN5503300000000|Dunn County, WI
F|CN5503500000000|Eau Claire County, WI
F|CN5503700000000|Florence County, WI
F|CN5503900000000|Fond du Lac County, WI
F|CN5504100000000|Forest County, WI
F|CN5504300000000|Grant County, WI
F|CN5504500000000|Green County, WI
F|CN5504700000000|Green Lake County, WI
F|CN5504900000000|Iowa County, WI
F|CN5505100000000|Iron County, WI
F|CN5505300000000|Jackson County, WI
F|CN5505500000000|Jefferson County, WI
F|CN5505700000000|Juneau County, WI
F|CN5505900000000|Kenosha County, WI
F|CN5506100000000|Kewaunee County, WI
F|CN5506300000000|La Crosse County, WI
F|CN5506500000000|Lafayette County, WI
F|CN5506700000000|Langlade County, WI
F|CN5506900000000|Lincoln County, WI
F|CN5507100000000|Manitowoc County, WI
F|CN5507300000000|Marathon County, WI
F|CN5507500000000|Marinette County, WI
F|CN5507700000000|Marquette County, WI
F|CN5507800000000|Menominee County, WI
F|CN5507900000000|Milwaukee County, WI
F|CN5508100000000|Monroe County, WI
F|CN5508300000000|Oconto County, WI
F|CN5508500000000|Oneida County, WI
F|CN5508700000000|Outagamie County, WI
F|CN5508900000000|Ozaukee County, WI
F|CN5509100000000|Pepin County, WI
F|CN5509300000000|Pierce County, WI
F|CN5509500000000|Polk County, WI
F|CN5509700000000|Portage County, WI
F|CN5509900000000|Price County, WI
F|CN5510100000000|Racine County, WI
F|CN5510300000000|Richland County, WI
F|CN5510500000000|Rock County, WI
F|CN5510700000000|Rusk County, WI
F|CN5510900000000|St. Croix County, WI
F|CN5511100000000|Sauk County, WI
F|CN5511300000000|Sawyer County, WI
F|CN5511500000000|Shawano County, WI
F|CN5511700000000|Sheboygan County, WI
F|CN5511900000000|Taylor County, WI
F|CN5512100000000|Trempealeau County, WI
F|CN5512300000000|Vernon County, WI
F|CN5512500000000|Vilas County, WI
F|CN5512700000000|Walworth County, WI
F|CN5512900000000|Washburn County, WI
F|CN5513100000000|Washington County, WI
F|CN5513300000000|Waukesha County, WI
F|CN5513500000000|Waupaca County, WI
F|CN5513700000000|Waushara County, WI
F|CN5513900000000|Winnebago County, WI
F|CN5514100000000|Wood County, WI
F|CN5600100000000|Albany County, WY
F|CN5600300000000|Big Horn County, WY
F|CN5600500000000|Campbell County, WY
F|CN5600700000000|Carbon County, WY
F|CN5600900000000|Converse County, WY
F|CN5601100000000|Crook County, WY
F|CN5601300000000|Fremont County, WY
F|CN5601500000000|Goshen County, WY
F|CN5601700000000|Hot Springs County, WY
F|CN5601900000000|Johnson County, WY
F|CN5602100000000|Laramie County, WY
F|CN5602300000000|Lincoln County, WY
F|CN5602500000000|Natrona County, WY
F|CN5602700000000|Niobrara County, WY
F|CN5602900000000|Park County, WY
F|CN5603100000000|Platte County, WY
F|CN5603300000000|Sheridan County, WY
F|CN5603500000000|Sublette County, WY
F|CN5603700000000|Sweetwater County, WY
F|CN5603900000000|Teton County, WY
F|CN5604100000000|Uinta County, WY
F|CN5604300000000|Washakie County, WY
F|CN5604500000000|Weston County, WY
F|CN7200100000000|Adjuntas Municipio, PR
F|CN7200300000000|Aguada Municipio, PR
F|CN7200500000000|Aguadilla Municipio, PR
F|CN7200700000000|Aguas Buenas Municipio, PR
F|CN7200900000000|Aibonito Municipio, PR
F|CN7201100000000|Anasco Municipio, PR
F|CN7201300000000|Arecibo Municipio, PR
F|CN7201500000000|Arroyo Municipio, PR
F|CN7201700000000|Barceloneta Municipio, PR
F|CN7201900000000|Barranquitas Municipio, PR
F|CN7202100000000|Bayamon Municipio, PR
F|CN7202300000000|Cabo Rojo Municipio, PR
F|CN7202500000000|Caguas Municipio, PR
F|CN7202700000000|Camuy Municipio, PR
F|CN7202900000000|Canovanas Municipio, PR
F|CN7203100000000|Carolina Municipio, PR
F|CN7203300000000|Catano Municipio, PR
F|CN7203500000000|Cayey Municipio, PR
F|CN7203700000000|Ceiba Municipio, PR
F|CN7203900000000|Ciales Municipio, PR
F|CN7204100000000|Cidra Municipio, PR
F|CN7204300000000|Coamo Municipio, PR
F|CN7204500000000|Comerio Municipio, PR
F|CN7204700000000|Corozal Municipio, PR
F|CN7204900000000|Culebra Municipio, PR
F|CN7205100000000|Dorado Municipio, PR
F|CN7205300000000|Fajardo Municipio, PR
F|CN7205400000000|Florida Municipio, PR
F|CN7205500000000|Guanica Municipio, PR
F|CN7205700000000|Guayama Municipio, PR
F|CN7205900000000|Guayanilla Municipio, PR
F|CN7206100000000|Guaynabo Municipio, PR
F|CN7206300000000|Gurabo Municipio, PR
F|CN7206500000000|Hatillo Municipio, PR
F|CN7206700000000|Hormigueros Municipio, PR
F|CN7206900000000|Humacao Municipio, PR
F|CN7207100000000|Isabela Municipio, PR
F|CN7207300000000|Jayuya Municipio, PR
F|CN7207500000000|Juana Diaz Municipio, PR
F|CN7207700000000|Juncos Municipio, PR
F|CN7207900000000|Lajas Municipio, PR
F|CN7208100000000|Lares Municipio, PR
F|CN7208300000000|Las Marias Municipio, PR
F|CN7208500000000|Las Piedras Municipio, PR
F|CN7208700000000|Loiza Municipio, PR
F|CN7208900000000|Luquillo Municipio, PR
F|CN7209100000000|Manati Municipio, PR
F|CN7209300000000|Maricao Municipio, PR
F|CN7209500000000|Maunabo Municipio, PR
F|CN7209700000000|Mayaguez Municipio, PR
F|CN7209900000000|Moca Municipio, PR
F|CN7210100000000|Morovis Municipio, PR
F|CN7210300000000|Naguabo Municipio, PR
F|CN7210500000000|Naranjito Municipio, PR
F|CN7210700000000|Orocovis Municipio, PR
F|CN7210900000000|Patillas Municipio, PR
F|CN7211100000000|Penuelas Municipio, PR
F|CN7211300000000|Ponce Municipio, PR
F|CN7211500000000|Quebradillas Municipio, PR
F|CN7211700000000|Rincon Municipio, PR
F|CN7211900000000|Rio Grande Municipio, PR
F|CN7212100000000|Sabana Grande Municipio, PR
F|CN7212300000000|Salinas Municipio, PR
F|CN7212500000000|San German Municipio, PR
F|CN7212700000000|San Juan Municipio, PR
F|CN7212900000000|San Lorenzo Municipio, PR
F|CN7213100000000|San Sebastian Municipio, PR
F|CN7213300000000|Santa Isabel Municipio, PR
F|CN7213500000000|Toa Alta Municipio, PR
F|CN7213700000000|Toa Baja Municipio, PR
F|CN7213900000000|Trujillo Alto Municipio, PR
F|CN7214100000000|Utuado Municipio, PR
F|CN7214300000000|Vega Alta Municipio, PR
F|CN7214500000000|Vega Baja Municipio, PR
F|CN7214700000000|Vieques Municipio, PR
F|CN7214900000000|Villalba Municipio, PR
F|CN7215100000000|Yabucoa Municipio, PR
F|CN7215300000000|Yauco Municipio, PR
G|CS0907310000000|Branford town, CT
G|CS0914160000000|Cheshire town, CT
G|CS0922630000000|East Hartford town, CT
G|CS0922910000000|East Haven town, CT
G|CS0925990000000|Enfield town, CT
G|CS0926620000000|Fairfield town, CT
G|CS0927600000000|Farmington town, CT
G|CS0931240000000|Glastonbury town, CT
G|CS0933620000000|Greenwich town, CT
G|CS0934250000000|Groton town, CT
G|CS0935650000000|Hamden town, CT
G|CS0944700000000|Manchester town, CT
G|CS0944910000000|Mansfield town, CT
G|CS0952140000000|Newington town, CT
G|CS0952630000000|New Milford town, CT
G|CS0952980000000|Newtown town, CT
G|CS0963970000000|Ridgefield town, CT
G|CS0970550000000|Southington town, CT
G|CS0971390000000|South Windsor town, CT
G|CS0974190000000|Stratford town, CT
G|CS0977200000000|Trumbull town, CT
G|CS0978250000000|Vernon town, CT
G|CS0978740000000|Wallingford town, CT
G|CS0982590000000|West Hartford town, CT
G|CS0983500000000|Westport town, CT
G|CS0984900000000|Wethersfield town, CT
G|CS0987000000000|Windsor town, CT
G|CS2501465000000|Andover town, MA
G|CS2501605000000|Arlington town, MA
G|CS2505070000000|Belmont town, MA
G|CS2505805000000|Billerica town, MA
G|CS2509175000000|Brookline town, MA
G|CS2509840000000|Burlington town, MA
G|CS2513135000000|Chelmsford town, MA
G|CS2516250000000|Danvers town, MA
G|CS2516425000000|Dartmouth town, MA
G|CS2516495000000|Dedham town, MA
G|CS2517475000000|Dracut town, MA
G|CS2520100000000|Easton town, MA
G|CS2523105000000|Falmouth town, MA
G|CS2535215000000|Lexington town, MA
G|CS2538855000000|Marshfield town, MA
G|CS2541165000000|Milford town, MA
G|CS2541690000000|Milton town, MA
G|CS2543895000000|Natick town, MA
G|CS2544105000000|Needham town, MA
G|CS2546365000000|North Andover town, MA
G|CS2550250000000|Norwood town, MA
G|CS2554310000000|Plymouth town, MA
G|CS2556130000000|Reading town, MA
G|CS2560015000000|Saugus town, MA
G|CS2561800000000|Shrewsbury town, MA
G|CS2567945000000|Stoughton town, MA
G|CS2569415000000|Tewksbury town, MA
G|CS2572215000000|Wakefield town, MA
G|CS2572495000000|Walpole town, MA
G|CS2574175000000|Wellesley town, MA
G|CS2582525000000|Yarmouth town, MA
G|CS2601360000000|Allendale charter township, MI
G|CS2606740000000|Bedford township (Monroe County), MI
G|CS2608760000000|Blackman charter township, MI
G|CS2609110000000|Bloomfield charter township (Oakland County), MI
G|CS2611220000000|Brownstown charter township, MI
G|CS2612240000000|Byron township, MI
G|CS2613120000000|Canton charter township, MI
G|CS2615340000000|Chesterfield township, MI
G|CS2616520000000|Clinton charter township (Macomb County), MI
G|CS2617640000000|Commerce charter township, MI
G|CS2621420000000|Delhi charter township, MI
G|CS2621520000000|Delta charter township, MI
G|CS2629020000000|Flint charter township, MI
G|CS2631240000000|Gaines charter township, MI
G|CS2631880000000|Georgetown charter township, MI
G|CS2633300000000|Grand Blanc charter township, MI
G|CS2636820000000|Harrison charter township, MI
G|CS2638660000000|Holland charter township (Ottawa County), MI
G|CS2640400000000|Independence charter township, MI
G|CS2649820000000|Lyon charter township, MI
G|CS2650480000000|Macomb township, MI
G|CS2653140000000|Meridian charter township, MI
G|CS2655980000000|Mount Morris township, MI
G|CS2659000000000|Northville township, MI
G|CS2661100000000|Orion charter township, MI
G|CS2664560000000|Pittsfield charter township, MI
G|CS2664660000000|Plainfield charter township (Kent County), MI
G|CS2665080000000|Plymouth charter township, MI
G|CS2667625000000|Redford charter township, MI
G|CS2670540000000|Saginaw charter township, MI
G|CS2672820000000|Shelby charter township (Macomb County), MI
G|CS2681660000000|Van Buren charter township, MI
G|CS2684120000000|Washington charter township (Macomb County), MI
G|CS2684240000000|Waterford charter township, MI
G|CS2685480000000|West Bloomfield charter township, MI
G|CS2686860000000|White Lake charter township, MI
G|CS2689160000000|Ypsilanti charter township, MI
G|CS3317940000000|Derry town, NH
G|CS3337940000000|Hudson town, NH
G|CS3343220000000|Londonderry town, NH
G|CS3347540000000|Merrimack town, NH
G|CS3366660000000|Salem town, NH
G|CS3403050000000|Barnegat township, NJ
G|CS3404695000000|Belleville township, NJ
G|CS3405305000000|Berkeley township, NJ
G|CS3405560000000|Bernards township, NJ
G|CS3406260000000|Bloomfield township, NJ
G|CS3407420000000|Brick township, NJ
G|CS3407720000000|Bridgewater township, NJ
G|CS3412280000000|Cherry Hill township, NJ
G|CS3413045000000|City of Orange township, NJ
G|CS3417710000000|Deptford township, NJ
G|CS3419000000000|East Brunswick township, NJ
G|CS3419780000000|East Windsor township, NJ
G|CS3420230000000|Edison township, NJ
G|CS3420290000000|Egg Harbor township, NJ
G|CS3422110000000|Evesham township, NJ
G|CS3422185000000|Ewing township, NJ
G|CS3424900000000|Franklin township (Somerset County), NJ
G|CS3425230000000|Freehold township, NJ
G|CS3425560000000|Galloway township, NJ
G|CS3426760000000|Gloucester township, NJ
G|CS3429280000000|Hamilton township (Atlantic County), NJ
G|CS3429310000000|Hamilton township (Mercer County), NJ
G|CS3431890000000|Hillsborough township, NJ
G|CS3433300000000|Howell township, NJ
G|CS3434450000000|Irvington township, NJ
G|CS3434680000000|Jackson township, NJ
G|CS3437380000000|Lacey township, NJ
G|CS3438550000000|Lakewood township, NJ
G|CS3439510000000|Lawrence township (Mercer County), NJ
G|CS3440890000000|Livingston township, NJ
G|CS3442750000000|Mahwah township, NJ
G|CS3442990000000|Manalapan township, NJ
G|CS3443140000000|Manchester township, NJ
G|CS3443800000000|Maplewood township, NJ
G|CS3444070000000|Marlboro township, NJ
G|CS3445120000000|Medford township, NJ
G|CS3445990000000|Middletown township, NJ
G|CS3447250000000|Monroe township (Gloucester County), NJ
G|CS3447280000000|Monroe township (Middlesex County), NJ
G|CS3447500000000|Montclair township, NJ
G|CS3449020000000|Mount Laurel township, NJ
G|CS3449080000000|Mount Olive township, NJ
G|CS3449890000000|Neptune township, NJ
G|CS3452470000000|North Bergen township, NJ
G|CS3452560000000|North Brunswick township, NJ
G|CS3453680000000|Nutley township, NJ
G|CS3454270000000|Ocean township (Monmouth County), NJ
G|CS3454705000000|Old Bridge township, NJ
G|CS3456460000000|Parsippany-Troy Hills township, NJ
G|CS3457510000000|Pemberton township, NJ
G|CS3457660000000|Pennsauken township, NJ
G|CS3459010000000|Piscataway township, NJ
G|CS3461890000000|Randolph township, NJ
G|CS3461920000000|Raritan township, NJ
G|CS3464080000000|Rockaway township, NJ
G|CS3466060000000|Scotch Plains township, NJ
G|CS3468790000000|South Brunswick township, NJ
G|CS3470320000000|Stafford township, NJ
G|CS3472360000000|Teaneck township, NJ
G|CS3473125000000|Toms River township, NJ
G|CS3474480000000|Union township (Union County), NJ
G|CS3475740000000|Vernon township, NJ
G|CS3476220000000|Voorhees township, NJ
G|CS3476460000000|Wall township, NJ
G|CS3477180000000|Washington township (Gloucester County), NJ
G|CS3477840000000|Wayne township, NJ
G|CS3479460000000|West Milford township, NJ
G|CS3479800000000|West Orange township, NJ
G|CS3480240000000|West Windsor township, NJ
G|CS3481440000000|Willingboro township, NJ
G|CS3481740000000|Winslow township, NJ
G|CS3482000000000|Woodbridge township, NJ
G|CS3602000000000|Amherst town, NY
G|CS3604000000000|Babylon town, NY
G|CS3606354000000|Bethlehem town, NY
G|CS3608246000000|Brighton town (Monroe County), NY
G|CS3610000000000|Brookhaven town, NY
G|CS3611913000000|Camillus town, NY
G|CS3612529000000|Carmel town, NY
G|CS3615011000000|Cheektowaga town, NY
G|CS3615462000000|Chili town, NY
G|CS3615704000000|Cicero town, NY
G|CS3615825000000|Clarence town, NY
G|CS3615968000000|Clarkstown town, NY
G|CS3616067000000|Clay town, NY
G|CS3616353000000|Clifton Park town, NY
G|CS3617343000000|Colonie town, NY
G|CS3618410000000|Cortlandt town, NY
G|CS3620478000000|De Witt town, NY
G|CS3621820000000|Eastchester town, NY
G|CS3621996000000|East Fishkill town, NY
G|CS3622194000000|East Hampton town, NY
G|CS3628442000000|Gates town, NY
G|CS3629366000000|Glenville town, NY
G|CS3630290000000|Greece town, NY
G|CS3630367000000|Greenburgh town, NY
G|CS3631104000000|Guilderland town, NY
G|CS3631489000000|Halfmoon town, NY
G|CS3631654000000|Hamburg town, NY
G|CS3632765000000|Haverstraw town, NY
G|CS3634000000000|Hempstead town, NY
G|CS3634099000000|Henrietta town, NY
G|CS3637000000000|Huntington town, NY
G|CS3637726000000|Irondequoit town, NY
G|CS3638000000000|Islip town, NY
G|CS3641146000000|Lancaster town, NY
G|CS3642015000000|Le Ray town, NY
G|CS3644842000000|Mamaroneck town, NY
G|CS3645029000000|Manlius town, NY
G|CS3647999000000|Monroe town, NY
G|CS3649011000000|Mount Pleasant town, NY
G|CS3650045000000|Newburgh town, NY
G|CS3650848000000|New Windsor town, NY
G|CS3653000000000|North Hempstead town, NY
G|CS3655211000000|Orangetown town, NY
G|CS3655277000000|Orchard Park town, NY
G|CS3655541000000|Ossining town, NY
G|CS3656000000000|Oyster Bay town, NY
G|CS3656185000000|Palm Tree town, NY
G|CS3657144000000|Penfield town, NY
G|CS3657221000000|Perinton town, NY
G|CS3658365000000|Pittsford town, NY
G|CS3659652000000|Poughkeepsie town, NY
G|CS3660356000000|Queensbury town, NY
G|CS3660510000000|Ramapo town, NY
G|CS3661984000000|Riverhead town, NY
G|CS3663935000000|Rotterdam town, NY
G|CS3664320000000|Rye town, NY
G|CS3664815000000|Salina town, NY
G|CS3668000000000|Smithtown town, NY
G|CS3668473000000|Southampton town, NY
G|CS3675000000000|Tonawanda town, NY
G|CS3676056000000|Union town, NY
G|CS3677255000000|Vestal town, NY
G|CS3677992000000|Wallkill town, NY
G|CS3678157000000|Wappinger town, NY
G|CS3678366000000|Warwick town, NY
G|CS3678971000000|Webster town, NY
G|CS3680918000000|West Seneca town, NY
G|CS3684077000000|Yorktown town, NY
G|CS4200156000000|Abington township, PA
G|CS4205616000000|Bensalem township, PA
G|CS4206096000000|Bethlehem township, PA
G|CS4208768000000|Bristol township, PA
G|CS4212968000000|Cheltenham township, PA
G|CS4216920000000|Cranberry township (Butler County), PA
G|CS4218936000000|Derry township (Dauphin County), PA
G|CS4221232000000|East Hempfield township, PA
G|CS4224384000000|Exeter township (Berks County), PA
G|CS4225112000000|Falls township (Bucks County), PA
G|CS4232296000000|Hampden township, PA
G|CS4233144000000|Haverford township, PA
G|CS4233792000000|Hempfield township (Westmoreland County), PA
G|CS4235808000000|Horsham township, PA
G|CS4244952000000|Lower Macungie township, PA
G|CS4244968000000|Lower Makefield township, PA
G|CS4244976000000|Lower Merion township, PA
G|CS4245056000000|Lower Paxton township, PA
G|CS4245080000000|Lower Providence township, PA
G|CS4245900000000|McCandless township, PA
G|CS4246896000000|Manheim township (Lancaster County), PA
G|CS4249120000000|Middletown township (Bucks County), PA
G|CS4249548000000|Millcreek township (Erie County), PA
G|CS4250640000000|Montgomery township (Montgomery County), PA
G|CS4250784000000|Moon township, PA
G|CS4251696000000|Mount Lebanon township, PA
G|CS4254688000000|Northampton township (Bucks County), PA
G|CS4255128000000|North Huntingdon township, PA
G|CS4259032000000|Penn Hills township, PA
G|CS4263264000000|Radnor township, PA
G|CS4264800000000|Ridley township, PA
G|CS4266264000000|Ross township (Allegheny County), PA
G|CS4269584000000|Shaler township, PA
G|CS4272824000000|Spring township (Berks County), PA
G|CS4272992000000|Springettsbury township, PA
G|CS4273032000000|Springfield township (Delaware County), PA
G|CS4275528000000|Susquehanna township (Dauphin County), PA
G|CS4275672000000|Swatara township (Dauphin County), PA
G|CS4277344000000|Tredyffrin township, PA
G|CS4279000000000|Upper Darby township, PA
G|CS4279008000000|Upper Dublin township, PA
G|CS4279104000000|Upper Macungie township, PA
G|CS4279136000000|Upper Merion township, PA
G|CS4279176000000|Upper Moreland township, PA
G|CS4279256000000|Upper Providence township (Montgomery County), PA
G|CS4280952000000|Warminster township, PA
G|CS4281048000000|Warrington township (Bucks County), PA
G|CS4284528000000|Whitehall township, PA
G|CS4287056000000|York township, PA
G|CS4418640000000|Coventry town, RI
G|CS4420080000000|Cumberland town, RI
G|CS4437720000000|Johnston town, RI
G|CS4451580000000|North Kingstown town, RI
G|CS4451760000000|North Providence town, RI
G|CS4467460000000|South Kingstown town, RI
G|CS4478440000000|West Warwick town, RI
G|CT0100820000000|Alabaster city, AL
G|CT0101852000000|Anniston city, AL
G|CT0102956000000|Athens city, AL
G|CT0103076000000|Auburn city, AL
G|CT0105980000000|Bessemer city, AL
G|CT0107000000000|Birmingham city, AL
G|CT0119648000000|Daphne city, AL
G|CT0120104000000|Decatur city, AL
G|CT0121184000000|Dothan city, AL
G|CT0124184000000|Enterprise city, AL
G|CT0125240000000|Fairhope city, AL
G|CT0126896000000|Florence city, AL
G|CT0126992000000|Foley city, AL
G|CT0128696000000|Gadsden city, AL
G|CT0135800000000|Homewood city, AL
G|CT0135896000000|Hoover city, AL
G|CT0137000000000|Huntsville city, AL
G|CT0145784000000|Madison city, AL
G|CT0150000000000|Mobile city, AL
G|CT0151000000000|Montgomery city, AL
G|CT0155200000000|Northport city, AL
G|CT0157048000000|Opelika city, AL
G|CT0158848000000|Pelham city, AL
G|CT0159472000000|Phenix City city, AL
G|CT0162328000000|Prattville city, AL
G|CT0162496000000|Prichard city, AL
G|CT0169120000000|Selma city, AL
G|CT0176944000000|Trussville city, AL
G|CT0177256000000|Tuscaloosa city, AL
G|CT0178552000000|Vestavia Hills city, AL
G|CT0203000000000|Anchorage Borough/municipality, AK
G|CT0224230000000|Fairbanks city, AK
G|CT0236400000000|Juneau Borough/city, AK
G|CT0270540000000|Sitka Borough/city, AK
G|CT0286380000000|Wrangell Borough/city, AK
G|CT0402830000000|Apache Junction city, AZ
G|CT0404720000000|Avondale city, AZ
G|CT0407940000000|Buckeye city, AZ
G|CT0408220000000|Bullhead City city, AZ
G|CT0410530000000|Casa Grande city, AZ
G|CT0412000000000|Chandler city, AZ
G|CT0422220000000|El Mirage city, AZ
G|CT0423620000000|Flagstaff city, AZ
G|CT0423760000000|Florence town, AZ
G|CT0425300000000|Fountain Hills town, AZ
G|CT0427400000000|Gilbert town, AZ
G|CT0427820000000|Glendale city, AZ
G|CT0428380000000|Goodyear city, AZ
G|CT0437620000000|Kingman city, AZ
G|CT0439370000000|Lake Havasu City city, AZ
G|CT0444270000000|Marana town, AZ
G|CT0444410000000|Maricopa city, AZ
G|CT0446000000000|Mesa city, AZ
G|CT0451600000000|Oro Valley town, AZ
G|CT0454050000000|Peoria city, AZ
G|CT0455000000000|Phoenix city, AZ
G|CT0457380000000|Prescott city, AZ
G|CT0457450000000|Prescott Valley town, AZ
G|CT0458150000000|Queen Creek town, AZ
G|CT0462140000000|Sahuarita town, AZ
G|CT0463470000000|San Luis city, AZ
G|CT0465000000000|Scottsdale city, AZ
G|CT0466820000000|Sierra Vista city, AZ
G|CT0471510000000|Surprise city, AZ
G|CT0473000000000|Tempe city, AZ
G|CT0477000000000|Tucson city, AZ
G|CT0485540000000|Yuma city, AZ
G|CT0504840000000|Bella Vista city, AR
G|CT0505290000000|Benton city, AR
G|CT0505320000000|Bentonville city, AR
G|CT0510300000000|Cabot city, AR
G|CT0512820000000|Centerton city, AR
G|CT0515190000000|Conway city, AR
G|CT0523290000000|Fayetteville city, AR
G|CT0524550000000|Fort Smith city, AR
G|CT0533400000000|Hot Springs city, AR
G|CT0534750000000|Jacksonville city, AR
G|CT0535710000000|Jonesboro city, AR
G|CT0541000000000|Little Rock city, AR
G|CT0550450000000|North Little Rock city, AR
G|CT0553390000000|Paragould city, AR
G|CT0555310000000|Pine Bluff city, AR
G|CT0560410000000|Rogers city, AR
G|CT0561670000000|Russellville city, AR
G|CT0563800000000|Sherwood city, AR
G|CT0566080000000|Springdale city, AR
G|CT0568810000000|Texarkana city, AR
G|CT0574540000000|West Memphis city, AR
G|CT0600296000000|Adelanto city, CA
G|CT0600394000000|Agoura Hills city, CA
G|CT0600562000000|Alameda city, CA
G|CT0600884000000|Alhambra city, CA
G|CT0600947000000|Aliso Viejo city, CA
G|CT0602000000000|Anaheim city, CA
G|CT0602252000000|Antioch city, CA
G|CT0602364000000|Apple Valley town, CA
G|CT0602462000000|Arcadia city, CA
G|CT0603064000000|Atascadero city, CA
G|CT0603162000000|Atwater city, CA
G|CT0603386000000|Azusa city, CA
G|CT0603526000000|Bakersfield city, CA
G|CT0603666000000|Baldwin Park city, CA
G|CT0603820000000|Banning city, CA
G|CT0604030000000|Barstow city, CA
G|CT0604758000000|Beaumont city, CA
G|CT0604870000000|Bell city, CA
G|CT0604982000000|Bellflower city, CA
G|CT0604996000000|Bell Gardens city, CA
G|CT0605108000000|Belmont city, CA
G|CT0605290000000|Benicia city, CA
G|CT0606000000000|Berkeley city, CA
G|CT0606308000000|Beverly Hills city, CA
G|CT0608058000000|Brawley city, CA
G|CT0608100000000|Brea city, CA
G|CT0608142000000|Brentwood city, CA
G|CT0608786000000|Buena Park city, CA
G|CT0608954000000|Burbank city, CA
G|CT0609066000000|Burlingame city, CA
G|CT0609710000000|Calexico city, CA
G|CT0610046000000|Camarillo city, CA
G|CT0610345000000|Campbell city, CA
G|CT0611194000000|Carlsbad city, CA
G|CT0611530000000|Carson city, CA
G|CT0612048000000|Cathedral City city, CA
G|CT0612524000000|Ceres city, CA
G|CT0612552000000|Cerritos city, CA
G|CT0613014000000|Chico city, CA
G|CT0613210000000|Chino city, CA
G|CT0613214000000|Chino Hills city, CA
G|CT0613392000000|Chula Vista city, CA
G|CT0613588000000|Citrus Heights city, CA
G|CT0613756000000|Claremont city, CA
G|CT0614218000000|Clovis city, CA
G|CT0614260000000|Coachella city, CA
G|CT0614890000000|Colton city, CA
G|CT0615044000000|Compton city, CA
G|CT0616000000000|Concord city, CA
G|CT0616224000000|Corcoran city, CA
G|CT0616350000000|Corona city, CA
G|CT0616378000000|Coronado city, CA
G|CT0616532000000|Costa Mesa city, CA
G|CT0616742000000|Covina city, CA
G|CT0617498000000|Cudahy city, CA
G|CT0617568000000|Culver City city, CA
G|CT0617610000000|Cupertino city, CA
G|CT0617750000000|Cypress city, CA
G|CT0617918000000|Daly City city, CA
G|CT0617946000000|Dana Point city, CA
G|CT0617988000000|Danville town, CA
G|CT0618100000000|Davis city, CA
G|CT0618394000000|Delano city, CA
G|CT0618996000000|Desert Hot Springs city, CA
G|CT0619192000000|Diamond Bar city, CA
G|CT0619318000000|Dinuba city, CA
G|CT0619766000000|Downey city, CA
G|CT0620018000000|Dublin city, CA
G|CT0620956000000|East Palo Alto city, CA
G|CT0621230000000|Eastvale city, CA
G|CT0621712000000|El Cajon city, CA
G|CT0621782000000|El Centro city, CA
G|CT0621796000000|El Cerrito city, CA
G|CT0622020000000|Elk Grove city, CA
G|CT0622230000000|El Monte city, CA
G|CT0622300000000|El Paso de Robles (Paso Robles) city, CA
G|CT0622678000000|Encinitas city, CA
G|CT0622804000000|Escondido city, CA
G|CT0623042000000|Eureka city, CA
G|CT0623182000000|Fairfield city, CA
G|CT0624638000000|Folsom city, CA
G|CT0624680000000|Fontana city, CA
G|CT0625338000000|Foster City city, CA
G|CT0625380000000|Fountain Valley city, CA
G|CT0626000000000|Fremont city, CA
G|CT0627000000000|Fresno city, CA
G|CT0628000000000|Fullerton city, CA
G|CT0628112000000|Galt city, CA
G|CT0628168000000|Gardena city, CA
G|CT0629000000000|Garden Grove city, CA
G|CT0629504000000|Gilroy city, CA
G|CT0630000000000|Glendale city, CA
G|CT0630014000000|Glendora city, CA
G|CT0630378000000|Goleta city, CA
G|CT0631960000000|Hanford city, CA
G|CT0632548000000|Hawthorne city, CA
G|CT0633000000000|Hayward city, CA
G|CT0633182000000|Hemet city, CA
G|CT0633308000000|Hercules city, CA
G|CT0633434000000|Hesperia city, CA
G|CT0633588000000|Highland city, CA
G|CT0634120000000|Hollister city, CA
G|CT0636000000000|Huntington Beach city, CA
G|CT0636056000000|Huntington Park city, CA
G|CT0636294000000|Imperial Beach city, CA
G|CT0636448000000|Indio city, CA
G|CT0636546000000|Inglewood city, CA
G|CT0636770000000|Irvine city, CA
G|CT0637692000000|Jurupa Valley city, CA
G|CT0639122000000|Lafayette city, CA
G|CT0639178000000|Laguna Beach city, CA
G|CT0639220000000|Laguna Hills city, CA
G|CT0639248000000|Laguna Niguel city, CA
G|CT0639290000000|La Habra city, CA
G|CT0639486000000|Lake Elsinore city, CA
G|CT0639496000000|Lake Forest city, CA
G|CT0639892000000|Lakewood city, CA
G|CT0640004000000|La Mesa city, CA
G|CT0640032000000|La Mirada city, CA
G|CT0640130000000|Lancaster city, CA
G|CT0640340000000|La Puente city, CA
G|CT0640354000000|La Quinta city, CA
G|CT0640704000000|Lathrop city, CA
G|CT0640830000000|La Verne city, CA
G|CT0640886000000|Lawndale city, CA
G|CT0641124000000|Lemon Grove city, CA
G|CT0641152000000|Lemoore city, CA
G|CT0641474000000|Lincoln city, CA
G|CT0641992000000|Livermore city, CA
G|CT0642202000000|Lodi city, CA
G|CT0642370000000|Loma Linda city, CA
G|CT0642524000000|Lompoc city, CA
G|CT0643000000000|Long Beach city, CA
G|CT0643280000000|Los Altos city, CA
G|CT0644000000000|Los Angeles city, CA
G|CT0644028000000|Los Banos city, CA
G|CT0644112000000|Los Gatos town, CA
G|CT0644574000000|Lynwood city, CA
G|CT0645022000000|Madera city, CA
G|CT0645400000000|Manhattan Beach city, CA
G|CT0645484000000|Manteca city, CA
G|CT0645778000000|Marina city, CA
G|CT0646114000000|Martinez city, CA
G|CT0646492000000|Maywood city, CA
G|CT0646842000000|Menifee city, CA
G|CT0646870000000|Menlo Park city, CA
G|CT0646898000000|Merced city, CA
G|CT0647766000000|Milpitas city, CA
G|CT0648256000000|Mission Viejo city, CA
G|CT0648354000000|Modesto city, CA
G|CT0648648000000|Monrovia city, CA
G|CT0648788000000|Montclair city, CA
G|CT0648816000000|Montebello city, CA
G|CT0648872000000|Monterey city, CA
G|CT0648914000000|Monterey Park city, CA
G|CT0649138000000|Moorpark city, CA
G|CT0649270000000|Moreno Valley city, CA
G|CT0649278000000|Morgan Hill city, CA
G|CT0649670000000|Mountain View city, CA
G|CT0650076000000|Murrieta city, CA
G|CT0650258000000|Napa city, CA
G|CT0650398000000|National City city, CA
G|CT0650916000000|Newark city, CA
G|CT0651182000000|Newport Beach city, CA
G|CT0651560000000|Norco city, CA
G|CT0652526000000|Norwalk city, CA
G|CT0652582000000|Novato city, CA
G|CT0653000000000|Oakland city, CA
G|CT0653070000000|Oakley city, CA
G|CT0653322000000|Oceanside city, CA
G|CT0653896000000|Ontario city, CA
G|CT0653980000000|Orange city, CA
G|CT0654652000000|Oxnard city, CA
G|CT0654806000000|Pacifica city, CA
G|CT0655156000000|Palmdale city, CA
G|CT0655184000000|Palm Desert city, CA
G|CT0655254000000|Palm Springs city, CA
G|CT0655282000000|Palo Alto city, CA
G|CT0655520000000|Paradise town, CA
G|CT0655618000000|Paramount city, CA
G|CT0656000000000|Pasadena city, CA
G|CT0656112000000|Patterson city, CA
G|CT0656700000000|Perris city, CA
G|CT0656784000000|Petaluma city, CA
G|CT0656924000000|Pico Rivera city, CA
G|CT0657456000000|Pittsburg city, CA
G|CT0657526000000|Placentia city, CA
G|CT0657764000000|Pleasant Hill city, CA
G|CT0657792000000|Pleasanton city, CA
G|CT0658072000000|Pomona city, CA
G|CT0658240000000|Porterville city, CA
G|CT0658520000000|Poway city, CA
G|CT0659444000000|Rancho Cordova city, CA
G|CT0659451000000|Rancho Cucamonga city, CA
G|CT0659514000000|Rancho Palos Verdes city, CA
G|CT0659587000000|Rancho Santa Margarita city, CA
G|CT0659920000000|Redding city, CA
G|CT0659962000000|Redlands city, CA
G|CT0660018000000|Redondo Beach city, CA
G|CT0660102000000|Redwood City city, CA
G|CT0660242000000|Reedley city, CA
G|CT0660466000000|Rialto city, CA
G|CT0660620000000|Richmond city, CA
G|CT0660704000000|Ridgecrest city, CA
G|CT0661068000000|Riverbank city, CA
G|CT0662000000000|Riverside city, CA
G|CT0662364000000|Rocklin city, CA
G|CT0662546000000|Rohnert Park city, CA
G|CT0662896000000|Rosemead city, CA
G|CT0662938000000|Roseville city, CA
G|CT0664000000000|Sacramento city, CA
G|CT0664224000000|Salinas city, CA
G|CT0665000000000|San Bernardino city, CA
G|CT0665028000000|San Bruno city, CA
G|CT0665042000000|San Buenaventura (Ventura) city, CA
G|CT0665070000000|San Carlos city, CA
G|CT0665084000000|San Clemente city, CA
G|CT0666000000000|San Diego city, CA
G|CT0666070000000|San Dimas city, CA
G|CT0667000000000|San Francisco County/city, CA
G|CT0667042000000|San Gabriel city, CA
G|CT0667056000000|Sanger city, CA
G|CT0667112000000|San Jacinto city, CA
G|CT0668000000000|San Jose city, CA
G|CT0668028000000|San Juan Capistrano city, CA
G|CT0668084000000|San Leandro city, CA
G|CT0668154000000|San Luis Obispo city, CA
G|CT0668196000000|San Marcos city, CA
G|CT0668252000000|San Mateo city, CA
G|CT0668294000000|San Pablo city, CA
G|CT0668364000000|San Rafael city, CA
G|CT0668378000000|San Ramon city, CA
G|CT0669000000000|Santa Ana city, CA
G|CT0669070000000|Santa Barbara city, CA
G|CT0669084000000|Santa Clara city, CA
G|CT0669088000000|Santa Clarita city, CA
G|CT0669112000000|Santa Cruz city, CA
G|CT0669196000000|Santa Maria city, CA
G|CT0670000000000|Santa Monica city, CA
G|CT0670042000000|Santa Paula city, CA
G|CT0670098000000|Santa Rosa city, CA
G|CT0670224000000|Santee city, CA
G|CT0670280000000|Saratoga city, CA
G|CT0670686000000|Seal Beach city, CA
G|CT0670742000000|Seaside city, CA
G|CT0672016000000|Simi Valley city, CA
G|CT0672520000000|Soledad city, CA
G|CT0673080000000|South Gate city, CA
G|CT0673220000000|South Pasadena city, CA
G|CT0673262000000|South San Francisco city, CA
G|CT0673962000000|Stanton city, CA
G|CT0675000000000|Stockton city, CA
G|CT0675630000000|Suisun City city, CA
G|CT0677000000000|Sunnyvale city, CA
G|CT0678120000000|Temecula city, CA
G|CT0678148000000|Temple City city, CA
G|CT0678582000000|Thousand Oaks city, CA
G|CT0680000000000|Torrance city, CA
G|CT0680238000000|Tracy city, CA
G|CT0680644000000|Tulare city, CA
G|CT0680812000000|Turlock city, CA
G|CT0680854000000|Tustin city, CA
G|CT0680994000000|Twentynine Palms city, CA
G|CT0681204000000|Union City city, CA
G|CT0681344000000|Upland city, CA
G|CT0681554000000|Vacaville city, CA
G|CT0681666000000|Vallejo city, CA
G|CT0682590000000|Victorville city, CA
G|CT0682954000000|Visalia city, CA
G|CT0682996000000|Vista city, CA
G|CT0683332000000|Walnut city, CA
G|CT0683346000000|Walnut Creek city, CA
G|CT0683542000000|Wasco city, CA
G|CT0683668000000|Watsonville city, CA
G|CT0684200000000|West Covina city, CA
G|CT0684410000000|West Hollywood city, CA
G|CT0684550000000|Westminster city, CA
G|CT0684816000000|West Sacramento city, CA
G|CT0685292000000|Whittier city, CA
G|CT0685446000000|Wildomar city, CA
G|CT0685922000000|Windsor town, CA
G|CT0686328000000|Woodland city, CA
G|CT0686832000000|Yorba Linda city, CA
G|CT0686972000000|Yuba City city, CA
G|CT0687042000000|Yucaipa city, CA
G|CT0803455000000|Arvada city, CO
G|CT0804000000000|Aurora city, CO
G|CT0807850000000|Boulder city, CO
G|CT0808675000000|Brighton city, CO
G|CT0809280000000|Broomfield County/city, CO
G|CT0812415000000|Castle Rock town, CO
G|CT0812815000000|Centennial city, CO
G|CT0816000000000|Colorado Springs city, CO
G|CT0816495000000|Commerce City city, CO
G|CT0820000000000|Denver County/city, CO
G|CT0824785000000|Englewood city, CO
G|CT0824950000000|Erie town, CO
G|CT0827425000000|Fort Collins city, CO
G|CT0827865000000|Fountain city, CO
G|CT0831660000000|Grand Junction city, CO
G|CT0832155000000|Greeley city, CO
G|CT0841835000000|Lafayette city, CO
G|CT0843000000000|Lakewood city, CO
G|CT0845255000000|Littleton city, CO
G|CT0845970000000|Longmont city, CO
G|CT0846465000000|Loveland city, CO
G|CT0854330000000|Northglenn city, CO
G|CT0857630000000|Parker town, CO
G|CT0862000000000|Pueblo city, CO
G|CT0877290000000|Thornton city, CO
G|CT0883835000000|Westminster city, CO
G|CT0884440000000|Wheat Ridge city, CO
G|CT0885485000000|Windsor town, CO
G|CT0908000000000|Bridgeport city/town, CT
G|CT0908420000000|Bristol city/town, CT
G|CT0918430000000|Danbury city/town, CT
G|CT0937000000000|Hartford city/town, CT
G|CT0946450000000|Meriden city/town, CT
G|CT0947290000000|Middletown city/town, CT
G|CT0947500000000|Milford (consolidated) city/town, CT
G|CT0949880000000|Naugatuck borough/town, CT
G|CT0950370000000|New Britain city/town, CT
G|CT0952000000000|New Haven city/town, CT
G|CT0952280000000|New London city/town, CT
G|CT0955990000000|Norwalk city/town, CT
G|CT0956200000000|Norwich city/town, CT
G|CT0968100000000|Shelton city/town, CT
G|CT0973000000000|Stamford city/town, CT
G|CT0976500000000|Torrington city/town, CT
G|CT0980000000000|Waterbury city/town, CT
G|CT0982800000000|West Haven city/town, CT
G|CT1021200000000|Dover city, DE
G|CT1047030000000|Middletown town, DE
G|CT1050670000000|Newark city, DE
G|CT1077580000000|Wilmington city, DE
G|CT1150000000000|Washington city, DC
G|CT1200950000000|Altamonte Springs city, FL
G|CT1201700000000|Apopka city, FL
G|CT1202681000000|Aventura city, FL
G|CT1207300000000|Boca Raton city, FL
G|CT1207525000000|Bonita Springs city, FL
G|CT1207875000000|Boynton Beach city, FL
G|CT1207950000000|Bradenton city, FL
G|CT1210275000000|Cape Coral city, FL
G|CT1211050000000|Casselberry city, FL
G|CT1212875000000|Clearwater city, FL
G|CT1212925000000|Clermont city, FL
G|CT1213275000000|Coconut Creek city, FL
G|CT1214125000000|Cooper City city, FL
G|CT1214250000000|Coral Gables city, FL
G|CT1214400000000|Coral Springs city, FL
G|CT1215475000000|Crestview city, FL
G|CT1215968000000|Cutler Bay town, FL
G|CT1216335000000|Dania Beach city, FL
G|CT1216475000000|Davie town, FL
G|CT1216525000000|Daytona Beach city, FL
G|CT1216725000000|Deerfield Beach city, FL
G|CT1216875000000|DeLand city, FL
G|CT1217100000000|Delray Beach city, FL
G|CT1217200000000|Deltona city, FL
G|CT1217935000000|Doral city, FL
G|CT1218575000000|Dunedin city, FL
G|CT1221150000000|Estero village, FL
G|CT1221350000000|Eustis city, FL
G|CT1224000000000|Fort Lauderdale city, FL
G|CT1224125000000|Fort Myers city, FL
G|CT1224300000000|Fort Pierce city, FL
G|CT1225175000000|Gainesville city, FL
G|CT1227322000000|Greenacres city, FL
G|CT1228400000000|Haines City city, FL
G|CT1228452000000|Hallandale Beach city, FL
G|CT1230000000000|Hialeah city, FL
G|CT1232000000000|Hollywood city, FL
G|CT1232275000000|Homestead city, FL
G|CT1235000000000|Jacksonville city, FL
G|CT1235875000000|Jupiter town, FL
G|CT1236550000000|Key West city, FL
G|CT1236950000000|Kissimmee city, FL
G|CT1238250000000|Lakeland city, FL
G|CT1239081000000|Lake Worth Beach city, FL
G|CT1239425000000|Largo city, FL
G|CT1239525000000|Lauderdale Lakes city, FL
G|CT1239550000000|Lauderhill city, FL
G|CT1239875000000|Leesburg city, FL
G|CT1243125000000|Margate city, FL
G|CT1243975000000|Melbourne city, FL
G|CT1245000000000|Miami city, FL
G|CT1245025000000|Miami Beach city, FL
G|CT1245060000000|Miami Gardens city, FL
G|CT1245100000000|Miami Lakes town, FL
G|CT1245975000000|Miramar city, FL
G|CT1248625000000|New Smyrna Beach city, FL
G|CT1249425000000|North Lauderdale city, FL
G|CT1249450000000|North Miami city, FL
G|CT1249475000000|North Miami Beach city, FL
G|CT1249675000000|North Port city, FL
G|CT1250575000000|Oakland Park city, FL
G|CT1250750000000|Ocala city, FL
G|CT1251075000000|Ocoee city, FL
G|CT1253000000000|Orlando city, FL
G|CT1253150000000|Ormond Beach city, FL
G|CT1253575000000|Oviedo city, FL
G|CT1254000000000|Palm Bay city, FL
G|CT1254075000000|Palm Beach Gardens city, FL
G|CT1254200000000|Palm Coast city, FL
G|CT1254275000000|Palmetto Bay village, FL
G|CT1254450000000|Palm Springs village, FL
G|CT1254700000000|Panama City city, FL
G|CT1255125000000|Parkland city, FL
G|CT1255775000000|Pembroke Pines city, FL
G|CT1255925000000|Pensacola city, FL
G|CT1256975000000|Pinellas Park city, FL
G|CT1257425000000|Plantation city, FL
G|CT1257550000000|Plant City city, FL
G|CT1258050000000|Pompano Beach city, FL
G|CT1258575000000|Port Orange city, FL
G|CT1258715000000|Port St. Lucie city, FL
G|CT1260975000000|Riviera Beach city, FL
G|CT1261500000000|Rockledge city, FL
G|CT1262100000000|Royal Palm Beach village, FL
G|CT1262625000000|St. Cloud city, FL
G|CT1263000000000|St. Petersburg city, FL
G|CT1263650000000|Sanford city, FL
G|CT1264175000000|Sarasota city, FL
G|CT1264825000000|Sebastian city, FL
G|CT1269700000000|Sunrise city, FL
G|CT1270600000000|Tallahassee city, FL
G|CT1270675000000|Tamarac city, FL
G|CT1271000000000|Tampa city, FL
G|CT1271150000000|Tarpon Springs city, FL
G|CT1271400000000|Temple Terrace city, FL
G|CT1271900000000|Titusville city, FL
G|CT1273900000000|Venice city, FL
G|CT1275812000000|Wellington village, FL
G|CT1276500000000|West Melbourne city, FL
G|CT1276582000000|Weston city, FL
G|CT1276600000000|West Palm Beach city, FL
G|CT1278250000000|Winter Garden city, FL
G|CT1278275000000|Winter Haven city, FL
G|CT1278300000000|Winter Park city, FL
G|CT1278325000000|Winter Springs city, FL
G|CT1301052000000|Albany city, GA
G|CT1301696000000|Alpharetta city, GA
G|CT1303436000000|Athens-Clarke County (consolidated) city, GA
G|CT1304000000000|Atlanta city, GA
G|CT1304200000000|Augusta-Richmond County (consolidated) city, GA
G|CT1310944000000|Brookhaven city, GA
G|CT1312988000000|Canton city, GA
G|CT1313492000000|Carrollton city, GA
G|CT1313688000000|Cartersville city, GA
G|CT1315172000000|Chamblee city, GA
G|CT1319000000000|Columbus (consolidated) city, GA
G|CT1321380000000|Dalton city, GA
G|CT1322052000000|Decatur city, GA
G|CT1323900000000|Douglasville city, GA
G|CT1324600000000|Duluth city, GA
G|CT1324768000000|Dunwoody city, GA
G|CT1325720000000|East Point city, GA
G|CT1331908000000|Gainesville city, GA
G|CT1338964000000|Hinesville city, GA
G|CT1342425000000|Johns Creek city, GA
G|CT1343192000000|Kennesaw city, GA
G|CT1344340000000|LaGrange city, GA
G|CT1345488000000|Lawrenceville city, GA
G|CT1348288000000|Mableton city, GA
G|CT1348624000000|McDonough city, GA
G|CT1349008000000|Macon-Bibb County, GA
G|CT1349756000000|Marietta city, GA
G|CT1351670000000|Milton city, GA
G|CT1355020000000|Newnan city, GA
G|CT1359724000000|Peachtree City city, GA
G|CT1359735000000|Peachtree Corners city, GA
G|CT1362104000000|Pooler city, GA
G|CT1366668000000|Rome city, GA
G|CT1367284000000|Roswell city, GA
G|CT1368516000000|Sandy Springs city, GA
G|CT1369000000000|Savannah city, GA
G|CT1371492000000|Smyrna city, GA
G|CT1372122000000|South Fulton city, GA
G|CT1373256000000|Statesboro city, GA
G|CT1373704000000|Stockbridge city, GA
G|CT1373784000000|Stonecrest city, GA
G|CT1374180000000|Sugar Hill city, GA
G|CT1377652000000|Tucker city, GA
G|CT1378324000000|Union City city, GA
G|CT1378800000000|Valdosta city, GA
G|CT1380508000000|Warner Robins city, GA
G|CT1384176000000|Woodstock city, GA
G|CT1516999000000|Honolulu County/city, HI
G|CT1608830000000|Boise City city, ID
G|CT1612250000000|Caldwell city, ID
G|CT1616750000000|Coeur d'Alene city, ID
G|CT1623410000000|Eagle city, ID
G|CT1639700000000|Idaho Falls city, ID
G|CT1644290000000|Kuna city, ID
G|CT1646540000000|Lewiston city, ID
G|CT1652120000000|Meridian city, ID
G|CT1654550000000|Moscow city, ID
G|CT1656260000000|Nampa city, ID
G|CT1664090000000|Pocatello city, ID
G|CT1664810000000|Post Falls city, ID
G|CT1667420000000|Rexburg city, ID
G|CT1682810000000|Twin Falls city, ID
G|CT1700243000000|Addison village, IL
G|CT1700685000000|Algonquin village, IL
G|CT1701114000000|Alton city, IL
G|CT1702154000000|Arlington Heights village, IL
G|CT1703012000000|Aurora city, IL
G|CT1704013000000|Bartlett village, IL
G|CT1704078000000|Batavia city, IL
G|CT1704845000000|Belleville city, IL
G|CT1705092000000|Belvidere city, IL
G|CT1705573000000|Berwyn city, IL
G|CT1706613000000|Bloomington city, IL
G|CT1707133000000|Bolingbrook village, IL
G|CT1709447000000|Buffalo Grove village, IL
G|CT1709642000000|Burbank city, IL
G|CT1710487000000|Calumet City city, IL
G|CT1711163000000|Carbondale city, IL
G|CT1711332000000|Carol Stream village, IL
G|CT1711358000000|Carpentersville village, IL
G|CT1712385000000|Champaign city, IL
G|CT1714000000000|Chicago city, IL
G|CT1714026000000|Chicago Heights city, IL
G|CT1714351000000|Cicero town, IL
G|CT1715599000000|Collinsville city, IL
G|CT1717887000000|Crystal Lake city, IL
G|CT1718563000000|Danville city, IL
G|CT1718823000000|Decatur city, IL
G|CT1719161000000|DeKalb city, IL
G|CT1719642000000|Des Plaines city, IL
G|CT1720292000000|Dolton village, IL
G|CT1720591000000|Downers Grove village, IL
G|CT1722255000000|East St. Louis city, IL
G|CT1722697000000|Edwardsville city, IL
G|CT1723074000000|Elgin city, IL
G|CT1723256000000|Elk Grove Village village, IL
G|CT1723620000000|Elmhurst city, IL
G|CT1723724000000|Elmwood Park village, IL
G|CT1724582000000|Evanston city, IL
G|CT1727884000000|Freeport city, IL
G|CT1728326000000|Galesburg city, IL
G|CT1729730000000|Glendale Heights village, IL
G|CT1729756000000|Glen Ellyn village, IL
G|CT1729938000000|Glenview village, IL
G|CT1730926000000|Granite City city, IL
G|CT1732018000000|Gurnee village, IL
G|CT1732746000000|Hanover Park village, IL
G|CT1733383000000|Harvey city, IL
G|CT1734722000000|Highland Park city, IL
G|CT1735411000000|Hoffman Estates village, IL
G|CT1735835000000|Homer Glen village, IL
G|CT1736750000000|Huntley village, IL
G|CT1738570000000|Joliet city, IL
G|CT1738934000000|Kankakee city, IL
G|CT1741183000000|Lake in the Hills village, IL
G|CT1742028000000|Lansing village, IL
G|CT1744225000000|Lockport city, IL
G|CT1744407000000|Lombard village, IL
G|CT1745694000000|McHenry city, IL
G|CT1747774000000|Maywood village, IL
G|CT1748242000000|Melrose Park village, IL
G|CT1749867000000|Moline city, IL
G|CT1750647000000|Morton Grove village, IL
G|CT1751089000000|Mount Prospect village, IL
G|CT1751349000000|Mundelein village, IL
G|CT1751622000000|Naperville city, IL
G|CT1752584000000|New Lenox village, IL
G|CT1753000000000|Niles village, IL
G|CT1753234000000|Normal town, IL
G|CT1753481000000|Northbrook village, IL
G|CT1753559000000|North Chicago city, IL
G|CT1754638000000|Oak Forest city, IL
G|CT1754820000000|Oak Lawn village, IL
G|CT1754885000000|Oak Park village, IL
G|CT1755249000000|O'Fallon city, IL
G|CT1756640000000|Orland Park village, IL
G|CT1756887000000|Oswego village, IL
G|CT1757225000000|Palatine village, IL
G|CT1757732000000|Park Forest village, IL
G|CT1757875000000|Park Ridge city, IL
G|CT1758447000000|Pekin city, IL
G|CT1759000000000|Peoria city, IL
G|CT1760287000000|Plainfield village, IL
G|CT1762367000000|Quincy city, IL
G|CT1765000000000|Rockford city, IL
G|CT1765078000000|Rock Island city, IL
G|CT1765442000000|Romeoville village, IL
G|CT1766040000000|Round Lake Beach village, IL
G|CT1766703000000|St. Charles city, IL
G|CT1768003000000|Schaumburg village, IL
G|CT1770122000000|Skokie village, IL
G|CT1772000000000|Springfield city, IL
G|CT1773157000000|Streamwood village, IL
G|CT1775484000000|Tinley Park village, IL
G|CT1777005000000|Urbana city, IL
G|CT1777694000000|Vernon Hills village, IL
G|CT1779293000000|Waukegan city, IL
G|CT1780060000000|West Chicago city, IL
G|CT1780645000000|Westmont village, IL
G|CT1781048000000|Wheaton city, IL
G|CT1781087000000|Wheeling village, IL
G|CT1782075000000|Wilmette village, IL
G|CT1783245000000|Woodridge village, IL
G|CT1783349000000|Woodstock city, IL
G|CT1784038000000|Yorkville city, IL
G|CT1784220000000|Zion city, IL
G|CT1801468000000|Anderson city, IN
G|CT1805860000000|Bloomington city, IN
G|CT1808416000000|Brownsburg town, IN
G|CT1810342000000|Carmel city, IN
G|CT1814734000000|Columbus city, IN
G|CT1816138000000|Crown Point city, IN
G|CT1819486000000|East Chicago city, IN
G|CT1820728000000|Elkhart city, IN
G|CT1822000000000|Evansville city, IN
G|CT1823278000000|Fishers city, IN
G|CT1825000000000|Fort Wayne city, IN
G|CT1825450000000|Franklin city, IN
G|CT1827000000000|Gary city, IN
G|CT1828386000000|Goshen city, IN
G|CT1829520000000|Greenfield city, IN
G|CT1829898000000|Greenwood city, IN
G|CT1831000000000|Hammond city, IN
G|CT1834114000000|Hobart city, IN
G|CT1836000000000|Indianapolis (consolidated) city, IN
G|CT1836003000000|Indianapolis (incorporated) city, IN
G|CT1838358000000|Jeffersonville city, IN
G|CT1840392000000|Kokomo city, IN
G|CT1840788000000|Lafayette city, IN
G|CT1842426000000|Lawrence city, IN
G|CT1846908000000|Marion city, IN
G|CT1848528000000|Merrillville town, IN
G|CT1848798000000|Michigan City city, IN
G|CT1849932000000|Mishawaka city, IN
G|CT1851876000000|Muncie city, IN
G|CT1852326000000|New Albany city, IN
G|CT1854180000000|Noblesville city, IN
G|CT1860246000000|Plainfield town, IN
G|CT1861092000000|Portage city, IN
G|CT1864260000000|Richmond city, IN
G|CT1868220000000|Schererville town, IN
G|CT1871000000000|South Bend city, IN
G|CT1875428000000|Terre Haute city, IN
G|CT1878326000000|Valparaiso city, IN
G|CT1882700000000|Westfield city, IN
G|CT1882862000000|West Lafayette city, IN
G|CT1886372000000|Zionsville town, IN
G|CT1901855000000|Ames city, IA
G|CT1902305000000|Ankeny city, IA
G|CT1906355000000|Bettendorf city, IA
G|CT1909550000000|Burlington city, IA
G|CT1911755000000|Cedar Falls city, IA
G|CT1912000000000|Cedar Rapids city, IA
G|CT1914430000000|Clinton city, IA
G|CT1916860000000|Council Bluffs city, IA
G|CT1919000000000|Davenport city, IA
G|CT1921000000000|Des Moines city, IA
G|CT1922395000000|Dubuque city, IA
G|CT1928515000000|Fort Dodge city, IA
G|CT1938595000000|Iowa City city, IA
G|CT1939765000000|Johnston city, IA
G|CT1949485000000|Marion city, IA
G|CT1949755000000|Marshalltown city, IA
G|CT1950160000000|Mason City city, IA
G|CT1960465000000|Ottumwa city, IA
G|CT1973335000000|Sioux City city, IA
G|CT1979950000000|Urbandale city, IA
G|CT1982425000000|Waterloo city, IA
G|CT1982695000000|Waukee city, IA
G|CT1983910000000|West Des Moines city, IA
G|CT2017800000000|Derby city, KS
G|CT2018250000000|Dodge City city, KS
G|CT2021275000000|Emporia city, KS
G|CT2025325000000|Garden City city, KS
G|CT2025425000000|Gardner city, KS
G|CT2033625000000|Hutchinson city, KS
G|CT2035750000000|Junction City city, KS
G|CT2036000000000|Kansas City city, KS
G|CT2038900000000|Lawrence city, KS
G|CT2039000000000|Leavenworth city, KS
G|CT2039075000000|Leawood city, KS
G|CT2039350000000|Lenexa city, KS
G|CT2044250000000|Manhattan city, KS
G|CT2052575000000|Olathe city, KS
G|CT2053775000000|Overland Park city, KS
G|CT2062700000000|Salina city, KS
G|CT2064500000000|Shawnee city, KS
G|CT2071000000000|Topeka city, KS
G|CT2079000000000|Wichita city, KS
G|CT2102368000000|Ashland city, KY
G|CT2108902000000|Bowling Green city, KY
G|CT2117848000000|Covington city, KY
G|CT2124274000000|Elizabethtown city, KY
G|CT2127982000000|Florence city, KY
G|CT2128900000000|Frankfort city, KY
G|CT2130700000000|Georgetown city, KY
G|CT2135866000000|Henderson city, KY
G|CT2137918000000|Hopkinsville city, KY
G|CT2139142000000|Independence city, KY
G|CT2140222000000|Jeffersontown city, KY
G|CT2146027000000|Lexington-Fayette city, KY
G|CT2148003000000|Louisville-Jefferson County (consolidated) city, KY
G|CT2156136000000|Nicholasville city, KY
G|CT2158620000000|Owensboro city, KY
G|CT2158836000000|Paducah city, KY
G|CT2165226000000|Richmond city, KY
G|CT2200975000000|Alexandria city, LA
G|CT2205000000000|Baton Rouge city, LA
G|CT2208920000000|Bossier City city, LA
G|CT2213960000000|Central city, LA
G|CT2236255000000|Houma city, LA
G|CT2239475000000|Kenner city, LA
G|CT2240735000000|Lafayette city, LA
G|CT2241155000000|Lake Charles city, LA
G|CT2251410000000|Monroe city, LA
G|CT2254035000000|New Iberia city, LA
G|CT2255000000000|New Orleans city, LA
G|CT2270000000000|Shreveport city, LA
G|CT2270805000000|Slidell city, LA
G|CT2302795000000|Bangor city, ME
G|CT2338740000000|Lewiston city, ME
G|CT2360545000000|Portland city, ME
G|CT2371990000000|South Portland city, ME
G|CT2401600000000|Annapolis city, MD
G|CT2404000000000|Baltimore city, MD
G|CT2408775000000|Bowie city, MD
G|CT2418750000000|College Park city, MD
G|CT2430325000000|Frederick city, MD
G|CT2431175000000|Gaithersburg city, MD
G|CT2436075000000|Hagerstown city, MD
G|CT2445900000000|Laurel city, MD
G|CT2467675000000|Rockville city, MD
G|CT2469925000000|Salisbury city, MD
G|CT2500840000000|Agawam Town city, MA
G|CT2501370000000|Amherst Town city, MA
G|CT2502690000000|Attleboro city, MA
G|CT2503690000000|Barnstable Town city, MA
G|CT2505595000000|Beverly city, MA
G|CT2507000000000|Boston city, MA
G|CT2507740000000|Braintree Town city, MA
G|CT2508130000000|Bridgewater Town city, MA
G|CT2509000000000|Brockton city, MA
G|CT2511000000000|Cambridge city, MA
G|CT2513205000000|Chelsea city, MA
G|CT2513660000000|Chicopee city, MA
G|CT2521990000000|Everett city, MA
G|CT2523000000000|Fall River city, MA
G|CT2523875000000|Fitchburg city, MA
G|CT2524960000000|Framingham city, MA
G|CT2525172000000|Franklin Town city, MA
G|CT2526150000000|Gloucester city, MA
G|CT2529405000000|Haverhill city, MA
G|CT2530840000000|Holyoke city, MA
G|CT2534550000000|Lawrence city, MA
G|CT2535075000000|Leominster city, MA
G|CT2537000000000|Lowell city, MA
G|CT2537490000000|Lynn city, MA
G|CT2537875000000|Malden city, MA
G|CT2538715000000|Marlborough city, MA
G|CT2539835000000|Medford city, MA
G|CT2540115000000|Melrose city, MA
G|CT2540675000000|Methuen city, MA
G|CT2545000000000|New Bedford city, MA
G|CT2545560000000|Newton city, MA
G|CT2546330000000|Northampton city, MA
G|CT2546598000000|North Attleborough Town city, MA
G|CT2552490000000|Peabody city, MA
G|CT2553960000000|Pittsfield city, MA
G|CT2555745000000|Quincy city, MA
G|CT2556000000000|Randolph Town city, MA
G|CT2556585000000|Revere city, MA
G|CT2559105000000|Salem city, MA
G|CT2562535000000|Somerville city, MA
G|CT2567000000000|Springfield city, MA
G|CT2569170000000|Taunton city, MA
G|CT2572600000000|Waltham city, MA
G|CT2573405000000|Watertown city, MA
G|CT2576030000000|Westfield city, MA
G|CT2577890000000|West Springfield Town city, MA
G|CT2578972000000|Weymouth Town city, MA
G|CT2581035000000|Woburn city, MA
G|CT2582000000000|Worcester city, MA
G|CT2601380000000|Allen Park city, MI
G|CT2603000000000|Ann Arbor city, MI
G|CT2604105000000|Auburn Hills city, MI
G|CT2605920000000|Battle Creek city, MI
G|CT2606020000000|Bay City city, MI
G|CT2612060000000|Burton city, MI
G|CT2621000000000|Dearborn city, MI
G|CT2621020000000|Dearborn Heights city, MI
G|CT2622000000000|Detroit city, MI
G|CT2624120000000|East Lansing city, MI
G|CT2624290000000|Eastpointe city, MI
G|CT2627440000000|Farmington Hills city, MI
G|CT2627880000000|Ferndale city, MI
G|CT2629000000000|Flint city, MI
G|CT2631420000000|Garden City city, MI
G|CT2634000000000|Grand Rapids city, MI
G|CT2636280000000|Hamtramck city, MI
G|CT2638640000000|Holland city, MI
G|CT2640680000000|Inkster city, MI
G|CT2641420000000|Jackson city, MI
G|CT2642160000000|Kalamazoo city, MI
G|CT2642820000000|Kentwood city, MI
G|CT2646000000000|Lansing city, MI
G|CT2647800000000|Lincoln Park city, MI
G|CT2649000000000|Livonia city, MI
G|CT2650560000000|Madison Heights city, MI
G|CT2653780000000|Midland city, MI
G|CT2656020000000|Mount Pleasant city, MI
G|CT2656320000000|Muskegon city, MI
G|CT2659140000000|Norton Shores city, MI
G|CT2659440000000|Novi city, MI
G|CT2659920000000|Oak Park city, MI
G|CT2665440000000|Pontiac city, MI
G|CT2665560000000|Portage city, MI
G|CT2665820000000|Port Huron city, MI
G|CT2669035000000|Rochester Hills city, MI
G|CT2669420000000|Romulus city, MI
G|CT2669800000000|Roseville city, MI
G|CT2670040000000|Royal Oak city, MI
G|CT2670520000000|Saginaw city, MI
G|CT2670760000000|St. Clair Shores city, MI
G|CT2674900000000|Southfield city, MI
G|CT2674960000000|Southgate city, MI
G|CT2676460000000|Sterling Heights city, MI
G|CT2679000000000|Taylor city, MI
G|CT2680700000000|Troy city, MI
G|CT2682960000000|Walker city, MI
G|CT2684000000000|Warren city, MI
G|CT2686000000000|Westland city, MI
G|CT2688900000000|Wyandotte city, MI
G|CT2688940000000|Wyoming city, MI
G|CT2701486000000|Andover city, MN
G|CT2701900000000|Apple Valley city, MN
G|CT2702908000000|Austin city, MN
G|CT2706382000000|Blaine city, MN
G|CT2706616000000|Bloomington city, MN
G|CT2707948000000|Brooklyn Center city, MN
G|CT2707966000000|Brooklyn Park city, MN
G|CT2708794000000|Burnsville city, MN
G|CT2710846000000|Champlin city, MN
G|CT2710918000000|Chanhassen city, MN
G|CT2710972000000|Chaska city, MN
G|CT2713114000000|Coon Rapids city, MN
G|CT2713456000000|Cottage Grove city, MN
G|CT2717000000000|Duluth city, MN
G|CT2717288000000|Eagan city, MN
G|CT2718116000000|Eden Prairie city, MN
G|CT2718188000000|Edina city, MN
G|CT2718674000000|Elk River city, MN
G|CT2722814000000|Fridley city, MN
G|CT2731076000000|Inver Grove Heights city, MN
G|CT2735180000000|Lakeville city, MN
G|CT2739878000000|Mankato city, MN
G|CT2740166000000|Maple Grove city, MN
G|CT2740382000000|Maplewood city, MN
G|CT2743000000000|Minneapolis city, MN
G|CT2743252000000|Minnetonka city, MN
G|CT2743864000000|Moorhead city, MN
G|CT2747680000000|Oakdale city, MN
G|CT2749300000000|Owatonna city, MN
G|CT2751730000000|Plymouth city, MN
G|CT2752594000000|Prior Lake city, MN
G|CT2753026000000|Ramsey city, MN
G|CT2754214000000|Richfield city, MN
G|CT2754880000000|Rochester city, MN
G|CT2755726000000|Rosemount city, MN
G|CT2755852000000|Roseville city, MN
G|CT2756896000000|St. Cloud city, MN
G|CT2757220000000|St. Louis Park city, MN
G|CT2758000000000|St. Paul city, MN
G|CT2758738000000|Savage city, MN
G|CT2759350000000|Shakopee city, MN
G|CT2759998000000|Shoreview city, MN
G|CT2769970000000|White Bear Lake city, MN
G|CT2771032000000|Winona city, MN
G|CT2771428000000|Woodbury city, MN
G|CT2806220000000|Biloxi city, MS
G|CT2808300000000|Brandon city, MS
G|CT2814420000000|Clinton city, MS
G|CT2815380000000|Columbus city, MS
G|CT2829180000000|Greenville city, MS
G|CT2829700000000|Gulfport city, MS
G|CT2831020000000|Hattiesburg city, MS
G|CT2833700000000|Horn Lake city, MS
G|CT2836000000000|Jackson city, MS
G|CT2844520000000|Madison city, MS
G|CT2846640000000|Meridian city, MS
G|CT2854040000000|Olive Branch city, MS
G|CT2854840000000|Oxford city, MS
G|CT2855360000000|Pascagoula city, MS
G|CT2855760000000|Pearl city, MS
G|CT2869280000000|Southaven city, MS
G|CT2870240000000|Starkville city, MS
G|CT2874840000000|Tupelo city, MS
G|CT2876720000000|Vicksburg city, MS
G|CT2903160000000|Ballwin city, MO
G|CT2904384000000|Belton city, MO
G|CT2906652000000|Blue Springs city, MO
G|CT2911242000000|Cape Girardeau city, MO
G|CT2913600000000|Chesterfield city, MO
G|CT2915670000000|Columbia city, MO
G|CT2924778000000|Florissant city, MO
G|CT2927190000000|Gladstone city, MO
G|CT2928324000000|Grandview city, MO
G|CT2931276000000|Hazelwood city, MO
G|CT2935000000000|Independence city, MO
G|CT2937000000000|Jefferson City city, MO
G|CT2937592000000|Joplin city, MO
G|CT2938000000000|Kansas City city, MO
G|CT2939044000000|Kirkwood city, MO
G|CT2941348000000|Lee's Summit city, MO
G|CT2942032000000|Liberty city, MO
G|CT2946586000000|Maryland Heights city, MO
G|CT2952616000000|Nixa city, MO
G|CT2954074000000|O'Fallon city, MO
G|CT2960752000000|Raymore city, MO
G|CT2960788000000|Raytown city, MO
G|CT2964082000000|St. Charles city, MO
G|CT2964550000000|St. Joseph city, MO
G|CT2965000000000|St. Louis city, MO
G|CT2965126000000|St. Peters city, MO
G|CT2970000000000|Springfield city, MO
G|CT2975220000000|University City city, MO
G|CT2978442000000|Wentzville city, MO
G|CT2979820000000|Wildwood city, MO
G|CT3001675000000|Anaconda-Deer Lodge County city, MT
G|CT3006550000000|Billings city, MT
G|CT3008950000000|Bozeman city, MT
G|CT3011390000000|Butte-Silver Bow (consolidated) city, MT
G|CT3032800000000|Great Falls city, MT
G|CT3035600000000|Helena city, MT
G|CT3040075000000|Kalispell city, MT
G|CT3050200000000|Missoula city, MT
G|CT3103950000000|Bellevue city, NE
G|CT3110110000000|Columbus city, NE
G|CT3117670000000|Fremont city, NE
G|CT3119595000000|Grand Island city, NE
G|CT3121415000000|Hastings city, NE
G|CT3125055000000|Kearney city, NE
G|CT3128000000000|Lincoln city, NE
G|CT3134615000000|Norfolk city, NE
G|CT3137000000000|Omaha city, NE
G|CT3138295000000|Papillion city, NE
G|CT3209700000000|Carson City, NV
G|CT3224900000000|Fernley city, NV
G|CT3231900000000|Henderson city, NV
G|CT3240000000000|Las Vegas city, NV
G|CT3251800000000|North Las Vegas city, NV
G|CT3260600000000|Reno city, NV
G|CT3268400000000|Sparks city, NV
G|CT3314200000000|Concord city, NH
G|CT3318820000000|Dover city, NH
G|CT3345140000000|Manchester city, NH
G|CT3350260000000|Nashua city, NH
G|CT3365140000000|Rochester city, NH
G|CT3402080000000|Atlantic City city, NJ
G|CT3403580000000|Bayonne city, NJ
G|CT3405170000000|Bergenfield borough, NJ
G|CT3407600000000|Bridgeton city, NJ
G|CT3410000000000|Camden city, NJ
G|CT3410750000000|Carteret borough, NJ
G|CT3413570000000|Cliffside Park borough, NJ
G|CT3413690000000|Clifton city, NJ
G|CT3419390000000|East Orange city, NJ
G|CT3421000000000|Elizabeth city, NJ
G|CT3421480000000|Englewood city, NJ
G|CT3422470000000|Fair Lawn borough, NJ
G|CT3424420000000|Fort Lee borough, NJ
G|CT3425770000000|Garfield city, NJ
G|CT3428680000000|Hackensack city, NJ
G|CT3432250000000|Hoboken city, NJ
G|CT3436000000000|Jersey City city, NJ
G|CT3436510000000|Kearny town, NJ
G|CT3440350000000|Linden city, NJ
G|CT3441100000000|Lodi borough, NJ
G|CT3441310000000|Long Branch city, NJ
G|CT3446680000000|Millville city, NJ
G|CT3451000000000|Newark city, NJ
G|CT3451210000000|New Brunswick city, NJ
G|CT3455950000000|Paramus borough, NJ
G|CT3456550000000|Passaic city, NJ
G|CT3457000000000|Paterson city, NJ
G|CT3458200000000|Perth Amboy city, NJ
G|CT3459190000000|Plainfield city, NJ
G|CT3460900000000|Princeton, NJ
G|CT3461530000000|Rahway city, NJ
G|CT3463000000000|Ridgewood village, NJ
G|CT3465790000000|Sayreville borough, NJ
G|CT3469390000000|South Plainfield borough, NJ
G|CT3474000000000|Trenton city, NJ
G|CT3474630000000|Union City city, NJ
G|CT3476070000000|Vineland city, NJ
G|CT3479040000000|Westfield town, NJ
G|CT3479610000000|West New York town, NJ
G|CT3501780000000|Alamogordo city, NM
G|CT3502000000000|Albuquerque city, NM
G|CT3512150000000|Carlsbad city, NM
G|CT3516420000000|Clovis city, NM
G|CT3525800000000|Farmington city, NM
G|CT3532520000000|Hobbs city, NM
G|CT3539380000000|Las Cruces city, NM
G|CT3563460000000|Rio Rancho city, NM
G|CT3564930000000|Roswell city, NM
G|CT3570500000000|Santa Fe city, NM
G|CT3601000000000|Albany city, NY
G|CT3603078000000|Auburn city, NY
G|CT3606607000000|Binghamton city, NY
G|CT3611000000000|Buffalo city, NY
G|CT3624229000000|Elmira city, NY
G|CT3627485000000|Freeport village, NY
G|CT3629113000000|Glen Cove city, NY
G|CT3632402000000|Harrison village/town, NY
G|CT3633139000000|Hempstead village, NY
G|CT3638077000000|Ithaca city, NY
G|CT3638264000000|Jamestown city, NY
G|CT3639853000000|Kiryas Joel village, NY
G|CT3642554000000|Lindenhurst village, NY
G|CT3643082000000|Lockport city, NY
G|CT3643335000000|Long Beach city, NY
G|CT3647042000000|Middletown city, NY
G|CT3649121000000|Mount Vernon city, NY
G|CT3650034000000|Newburgh city, NY
G|CT3650617000000|New Rochelle city, NY
G|CT3651000000000|New York city, NY
G|CT3651055000000|Niagara Falls city, NY
G|CT3653682000000|North Tonawanda city, NY
G|CT3655530000000|Ossining village, NY
G|CT3656979000000|Peekskill city, NY
G|CT3659223000000|Port Chester village, NY
G|CT3659641000000|Poughkeepsie city, NY
G|CT3663000000000|Rochester city, NY
G|CT3663264000000|Rockville Centre village, NY
G|CT3663418000000|Rome city, NY
G|CT3665255000000|Saratoga Springs city, NY
G|CT3665508000000|Schenectady city, NY
G|CT3670420000000|Spring Valley village, NY
G|CT3673000000000|Syracuse city, NY
G|CT3675484000000|Troy city, NY
G|CT3676540000000|Utica city, NY
G|CT3676705000000|Valley Stream village, NY
G|CT3678608000000|Watertown city, NY
G|CT3681677000000|White Plains city, NY
G|CT3684000000000|Yonkers city, NY
G|CT3701520000000|Apex town, NC
G|CT3702080000000|Asheboro city, NC
G|CT3702140000000|Asheville city, NC
G|CT3709060000000|Burlington city, NC
G|CT3710740000000|Cary town, NC
G|CT3711800000000|Chapel Hill town, NC
G|CT3712000000000|Charlotte city, NC
G|CT3712860000000|Clayton town, NC
G|CT3714100000000|Concord city, NC
G|CT3714700000000|Cornelius town, NC
G|CT3719000000000|Durham city, NC
G|CT3722920000000|Fayetteville city, NC
G|CT3725300000000|Fuquay-Varina town, NC
G|CT3725480000000|Garner town, NC
G|CT3725580000000|Gastonia city, NC
G|CT3726880000000|Goldsboro city, NC
G|CT3728000000000|Greensboro city, NC
G|CT3728080000000|Greenville city, NC
G|CT3731060000000|Hickory city, NC
G|CT3731400000000|High Point city, NC
G|CT3732260000000|Holly Springs town, NC
G|CT3733120000000|Huntersville town, NC
G|CT3733560000000|Indian Trail town, NC
G|CT3734200000000|Jacksonville city, NC
G|CT3735200000000|Kannapolis city, NC
G|CT3735600000000|Kernersville town, NC
G|CT3735920000000|Kinston city, NC
G|CT3737680000000|Leland town, NC
G|CT3741960000000|Matthews town, NC
G|CT3743480000000|Mint Hill town, NC
G|CT3743920000000|Monroe city, NC
G|CT3744220000000|Mooresville town, NC
G|CT3744520000000|Morrisville town, NC
G|CT3746340000000|New Bern city, NC
G|CT3755000000000|Raleigh city, NC
G|CT3757500000000|Rocky Mount city, NC
G|CT3758860000000|Salisbury city, NC
G|CT3759280000000|Sanford city, NC
G|CT3764740000000|Statesville city, NC
G|CT3767420000000|Thomasville city, NC
G|CT3770540000000|Wake Forest town, NC
G|CT3774440000000|Wilmington city, NC
G|CT3774540000000|Wilson city, NC
G|CT3775000000000|Winston-Salem city, NC
G|CT3807200000000|Bismarck city, ND
G|CT3819620000000|Dickinson city, ND
G|CT3825700000000|Fargo city, ND
G|CT3832060000000|Grand Forks city, ND
G|CT3853380000000|Minot city, ND
G|CT3884780000000|West Fargo city, ND
G|CT3886220000000|Williston city, ND
G|CT3901000000000|Akron city, OH
G|CT3902736000000|Athens city, OH
G|CT3903352000000|Avon city, OH
G|CT3903464000000|Avon Lake city, OH
G|CT3903828000000|Barberton city, OH
G|CT3904720000000|Beavercreek city, OH
G|CT3907972000000|Bowling Green city, OH
G|CT3909680000000|Brunswick city, OH
G|CT3912000000000|Canton city, OH
G|CT3913190000000|Centerville city, OH
G|CT3915000000000|Cincinnati city, OH
G|CT3916000000000|Cleveland city, OH
G|CT3916014000000|Cleveland Heights city, OH
G|CT3918000000000|Columbus city, OH
G|CT3919778000000|Cuyahoga Falls city, OH
G|CT3921000000000|Dayton city, OH
G|CT3921434000000|Delaware city, OH
G|CT3922694000000|Dublin city, OH
G|CT3925256000000|Elyria city, OH
G|CT3925704000000|Euclid city, OH
G|CT3925914000000|Fairborn city, OH
G|CT3925970000000|Fairfield city, OH
G|CT3927048000000|Findlay city, OH
G|CT3929106000000|Gahanna city, OH
G|CT3929428000000|Garfield Heights city, OH
G|CT3931860000000|Green city, OH
G|CT3932592000000|Grove City city, OH
G|CT3933012000000|Hamilton city, OH
G|CT3935476000000|Hilliard city, OH
G|CT3936610000000|Huber Heights city, OH
G|CT3939872000000|Kent city, OH
G|CT3940040000000|Kettering city, OH
G|CT3941664000000|Lakewood city, OH
G|CT3941720000000|Lancaster city, OH
G|CT3943554000000|Lima city, OH
G|CT3944856000000|Lorain city, OH
G|CT3947138000000|Mansfield city, OH
G|CT3947306000000|Maple Heights city, OH
G|CT3947754000000|Marion city, OH
G|CT3948160000000|Marysville city, OH
G|CT3948188000000|Mason city, OH
G|CT3948244000000|Massillon city, OH
G|CT3948790000000|Medina city, OH
G|CT3949056000000|Mentor city, OH
G|CT3949840000000|Middletown city, OH
G|CT3954040000000|Newark city, OH
G|CT3956882000000|North Olmsted city, OH
G|CT3956966000000|North Ridgeville city, OH
G|CT3957008000000|North Royalton city, OH
G|CT3961000000000|Parma city, OH
G|CT3962148000000|Perrysburg city, OH
G|CT3962498000000|Pickerington city, OH
G|CT3966390000000|Reynoldsburg city, OH
G|CT3967468000000|Riverside city, OH
G|CT3970380000000|Sandusky city, OH
G|CT3971682000000|Shaker Heights city, OH
G|CT3973264000000|South Euclid city, OH
G|CT3974118000000|Springfield city, OH
G|CT3974944000000|Stow city, OH
G|CT3975098000000|Strongsville city, OH
G|CT3977000000000|Toledo city, OH
G|CT3977504000000|Trotwood city, OH
G|CT3977588000000|Troy city, OH
G|CT3979002000000|Upper Arlington city, OH
G|CT3980892000000|Warren city, OH
G|CT3983342000000|Westerville city, OH
G|CT3983622000000|Westlake city, OH
G|CT3986548000000|Wooster city, OH
G|CT3986772000000|Xenia city, OH
G|CT3988000000000|Youngstown city, OH
G|CT3988084000000|Zanesville city, OH
G|CT4002600000000|Ardmore city, OK
G|CT4004450000000|Bartlesville city, OK
G|CT4006400000000|Bixby city, OK
G|CT4009050000000|Broken Arrow city, OK
G|CT4019900000000|Del City city, OK
G|CT4023200000000|Edmond city, OK
G|CT4023950000000|Enid city, OK
G|CT4037800000000|Jenks city, OK
G|CT4041850000000|Lawton city, OK
G|CT4048350000000|Midwest City city, OK
G|CT4049200000000|Moore city, OK
G|CT4050050000000|Muskogee city, OK
G|CT4052500000000|Norman city, OK
G|CT4055000000000|Oklahoma City city, OK
G|CT4056650000000|Owasso city, OK
G|CT4059850000000|Ponca City city, OK
G|CT4066800000000|Shawnee city, OK
G|CT4070300000000|Stillwater city, OK
G|CT4075000000000|Tulsa city, OK
G|CT4082950000000|Yukon city, OK
G|CT4101000000000|Albany city, OR
G|CT4105350000000|Beaverton city, OR
G|CT4105800000000|Bend city, OR
G|CT4115800000000|Corvallis city, OR
G|CT4123850000000|Eugene city, OR
G|CT4126200000000|Forest Grove city, OR
G|CT4130550000000|Grants Pass city, OR
G|CT4131250000000|Gresham city, OR
G|CT4132050000000|Happy Valley city, OR
G|CT4134100000000|Hillsboro city, OR
G|CT4138500000000|Keizer city, OR
G|CT4140550000000|Lake Oswego city, OR
G|CT4145000000000|McMinnville city, OR
G|CT4147000000000|Medford city, OR
G|CT4152100000000|Newberg city, OR
G|CT4155200000000|Oregon City city, OR
G|CT4159000000000|Portland city, OR
G|CT4161200000000|Redmond city, OR
G|CT4164900000000|Salem city, OR
G|CT4169600000000|Springfield city, OR
G|CT4173650000000|Tigard city, OR
G|CT4174950000000|Tualatin city, OR
G|CT4180150000000|West Linn city, OR
G|CT4182800000000|Wilsonville city, OR
G|CT4183750000000|Woodburn city, OR
G|CT4202000000000|Allentown city, PA
G|CT4202184000000|Altoona city, PA
G|CT4206064000000|Bethel Park municipality, PA
G|CT4206088000000|Bethlehem city, PA
G|CT4213208000000|Chester city, PA
G|CT4221648000000|Easton city, PA
G|CT4224000000000|Erie city, PA
G|CT4232800000000|Harrisburg city, PA
G|CT4233408000000|Hazleton city, PA
G|CT4238288000000|Johnstown city, PA
G|CT4241216000000|Lancaster city, PA
G|CT4242168000000|Lebanon city, PA
G|CT4250528000000|Monroeville municipality, PA
G|CT4253368000000|New Castle city, PA
G|CT4254656000000|Norristown borough, PA
G|CT4260000000000|Philadelphia County/city, PA
G|CT4261000000000|Pittsburgh city, PA
G|CT4261536000000|Plum borough, PA
G|CT4263624000000|Reading city, PA
G|CT4269000000000|Scranton city, PA
G|CT4273808000000|State College borough, PA
G|CT4283512000000|West Mifflin borough, PA
G|CT4285152000000|Wilkes-Barre city, PA
G|CT4285312000000|Williamsport city, PA
G|CT4287048000000|York city, PA
G|CT4419180000000|Cranston city, RI
G|CT4422960000000|East Providence city, RI
G|CT4449960000000|Newport city, RI
G|CT4454640000000|Pawtucket city, RI
G|CT4459000000000|Providence city, RI
G|CT4474300000000|Warwick city, RI
G|CT4480780000000|Woonsocket city, RI
G|CT4500550000000|Aiken city, SC
G|CT4501360000000|Anderson city, SC
G|CT4507210000000|Bluffton town, SC
G|CT4513330000000|Charleston city, SC
G|CT4516000000000|Columbia city, SC
G|CT4516405000000|Conway city, SC
G|CT4521985000000|Easley city, SC
G|CT4525810000000|Florence city, SC
G|CT4526890000000|Fort Mill town, SC
G|CT4529815000000|Goose Creek city, SC
G|CT4530850000000|Greenville city, SC
G|CT4530985000000|Greer city, SC
G|CT4532065000000|Hanahan city, SC
G|CT4534045000000|Hilton Head Island town, SC
G|CT4541335000000|Lexington town, SC
G|CT4545115000000|Mauldin city, SC
G|CT4548535000000|Mount Pleasant town, SC
G|CT4549075000000|Myrtle Beach city, SC
G|CT4550695000000|North Augusta city, SC
G|CT4550875000000|North Charleston city, SC
G|CT4561405000000|Rock Hill city, SC
G|CT4566580000000|Simpsonville city, SC
G|CT4568290000000|Spartanburg city, SC
G|CT4570270000000|Summerville town, SC
G|CT4570405000000|Sumter city, SC
G|CT4600100000000|Aberdeen city, SD
G|CT4652980000000|Rapid City city, SD
G|CT4659020000000|Sioux Falls city, SD
G|CT4703440000000|Bartlett city, TN
G|CT4708280000000|Brentwood city, TN
G|CT4708540000000|Bristol city, TN
G|CT4714000000000|Chattanooga city, TN
G|CT4715160000000|Clarksville city, TN
G|CT4715400000000|Cleveland city, TN
G|CT4716420000000|Collierville town, TN
G|CT4716540000000|Columbia city, TN
G|CT4716920000000|Cookeville city, TN
G|CT4725760000000|Farragut town, TN
G|CT4727740000000|Franklin city, TN
G|CT4728540000000|Gallatin city, TN
G|CT4728960000000|Germantown city, TN
G|CT4733280000000|Hendersonville city, TN
G|CT4737640000000|Jackson city, TN
G|CT4738320000000|Johnson City city, TN
G|CT4739560000000|Kingsport city, TN
G|CT4740000000000|Knoxville city, TN
G|CT4741200000000|La Vergne city, TN
G|CT4741520000000|Lebanon city, TN
G|CT4746380000000|Maryville city, TN
G|CT4748000000000|Memphis city, TN
G|CT4750280000000|Morristown city, TN
G|CT4750780000000|Mount Juliet city, TN
G|CT4751560000000|Murfreesboro city, TN
G|CT4752004000000|Nashville-Davidson (consolidated) city, TN
G|CT4755120000000|Oak Ridge city, TN
G|CT4767760000000|Shelbyville city, TN
G|CT4769420000000|Smyrna town, TN
G|CT4770580000000|Spring Hill city, TN
G|CT4801000000000|Abilene city, TX
G|CT4801924000000|Allen city, TX
G|CT4802272000000|Alvin city, TX
G|CT4803000000000|Amarillo city, TX
G|CT4803300000000|Anna city, TX
G|CT4804000000000|Arlington city, TX
G|CT4805000000000|Austin city, TX
G|CT4805372000000|Balch Springs city, TX
G|CT4806128000000|Baytown city, TX
G|CT4807000000000|Beaumont city, TX
G|CT4807132000000|Bedford city, TX
G|CT4807492000000|Belton city, TX
G|CT4808236000000|Big Spring city, TX
G|CT4810768000000|Brownsville city, TX
G|CT4810912000000|Bryan city, TX
G|CT4811428000000|Burleson city, TX
G|CT4813024000000|Carrollton city, TX
G|CT4813492000000|Cedar Hill city, TX
G|CT4813552000000|Cedar Park city, TX
G|CT4813684000000|Celina city, TX
G|CT4814920000000|Cibolo city, TX
G|CT4815364000000|Cleburne city, TX
G|CT4815976000000|College Station city, TX
G|CT4815988000000|Colleyville city, TX
G|CT4816432000000|Conroe city, TX
G|CT4816468000000|Converse city, TX
G|CT4816612000000|Coppell city, TX
G|CT4816624000000|Copperas Cove city, TX
G|CT4817000000000|Corpus Christi city, TX
G|CT4817060000000|Corsicana city, TX
G|CT4819000000000|Dallas city, TX
G|CT4819624000000|Deer Park city, TX
G|CT4819792000000|Del Rio city, TX
G|CT4819900000000|Denison city, TX
G|CT4819972000000|Denton city, TX
G|CT4820092000000|DeSoto city, TX
G|CT4821628000000|Duncanville city, TX
G|CT4821892000000|Eagle Pass city, TX
G|CT4822660000000|Edinburg city, TX
G|CT4824000000000|El Paso city, TX
G|CT4824768000000|Euless city, TX
G|CT4825452000000|Farmers Branch city, TX
G|CT4825572000000|Fate city, TX
G|CT4826232000000|Flower Mound town, TX
G|CT4826604000000|Forney city, TX
G|CT4827000000000|Fort Worth city, TX
G|CT4827648000000|Friendswood city, TX
G|CT4827684000000|Frisco city, TX
G|CT4827876000000|Fulshear city, TX
G|CT4828068000000|Galveston city, TX
G|CT4829000000000|Garland city, TX
G|CT4829336000000|Georgetown city, TX
G|CT4830464000000|Grand Prairie city, TX
G|CT4830644000000|Grapevine city, TX
G|CT4830920000000|Greenville city, TX
G|CT4831928000000|Haltom City city, TX
G|CT4832312000000|Harker Heights city, TX
G|CT4832372000000|Harlingen city, TX
G|CT4835000000000|Houston city, TX
G|CT4835528000000|Huntsville city, TX
G|CT4835576000000|Hurst city, TX
G|CT4835624000000|Hutto city, TX
G|CT4837000000000|Irving city, TX
G|CT4838476000000|Katy city, TX
G|CT4838632000000|Keller city, TX
G|CT4839040000000|Kerrville city, TX
G|CT4839148000000|Killeen city, TX
G|CT4839352000000|Kingsville city, TX
G|CT4839952000000|Kyle city, TX
G|CT4840588000000|Lake Jackson city, TX
G|CT4841212000000|Lancaster city, TX
G|CT4841440000000|La Porte city, TX
G|CT4841464000000|Laredo city, TX
G|CT4841980000000|League City city, TX
G|CT4842016000000|Leander city, TX
G|CT4842508000000|Lewisville city, TX
G|CT4843012000000|Little Elm city, TX
G|CT4843888000000|Longview city, TX
G|CT4845000000000|Lubbock city, TX
G|CT4845072000000|Lufkin city, TX
G|CT4845384000000|McAllen city, TX
G|CT4845744000000|McKinney city, TX
G|CT4846452000000|Mansfield city, TX
G|CT4847496000000|Melissa city, TX
G|CT4847892000000|Mesquite city, TX
G|CT4848072000000|Midland city, TX
G|CT4848096000000|Midlothian city, TX
G|CT4848768000000|Mission city, TX
G|CT4848804000000|Missouri City city, TX
G|CT4850256000000|Nacogdoches city, TX
G|CT4850820000000|New Braunfels city, TX
G|CT4852356000000|North Richland Hills city, TX
G|CT4853388000000|Odessa city, TX
G|CT4855080000000|Paris city, TX
G|CT4856000000000|Pasadena city, TX
G|CT4856348000000|Pearland city, TX
G|CT4857176000000|Pflugerville city, TX
G|CT4857200000000|Pharr city, TX
G|CT4858016000000|Plano city, TX
G|CT4858820000000|Port Arthur city, TX
G|CT4859576000000|Princeton city, TX
G|CT4859696000000|Prosper town, TX
G|CT4861796000000|Richardson city, TX
G|CT4862828000000|Rockwall city, TX
G|CT4863284000000|Rosenberg city, TX
G|CT4863500000000|Round Rock city, TX
G|CT4863572000000|Rowlett city, TX
G|CT4863668000000|Royse City city, TX
G|CT4864064000000|Sachse city, TX
G|CT4864112000000|Saginaw city, TX
G|CT4864472000000|San Angelo city, TX
G|CT4865000000000|San Antonio city, TX
G|CT4865036000000|San Benito city, TX
G|CT4865516000000|San Juan city, TX
G|CT4865600000000|San Marcos city, TX
G|CT4866128000000|Schertz city, TX
G|CT4866644000000|Seguin city, TX
G|CT4867496000000|Sherman city, TX
G|CT4868636000000|Socorro city, TX
G|CT4869032000000|Southlake city, TX
G|CT4870808000000|Sugar Land city, TX
G|CT4872176000000|Temple city, TX
G|CT4872368000000|Texarkana city, TX
G|CT4872392000000|Texas City city, TX
G|CT4872530000000|The Colony city, TX
G|CT4874144000000|Tyler city, TX
G|CT4874492000000|University Park city, TX
G|CT4875428000000|Victoria city, TX
G|CT4876000000000|Waco city, TX
G|CT4876816000000|Waxahachie city, TX
G|CT4876864000000|Weatherford city, TX
G|CT4877272000000|Weslaco city, TX
G|CT4879000000000|Wichita Falls city, TX
G|CT4880356000000|Wylie city, TX
G|CT4901310000000|American Fork city, UT
G|CT4907690000000|Bountiful city, UT
G|CT4911320000000|Cedar City city, UT
G|CT4913850000000|Clearfield city, UT
G|CT4916270000000|Cottonwood Heights city, UT
G|CT4920120000000|Draper city, UT
G|CT4920810000000|Eagle Mountain city, UT
G|CT4924740000000|Farmington city, UT
G|CT4934970000000|Herriman city, UT
G|CT4936070000000|Holladay city, UT
G|CT4940360000000|Kaysville city, UT
G|CT4940470000000|Kearns metro township, UT
G|CT4943660000000|Layton city, UT
G|CT4944320000000|Lehi city, UT
G|CT4945860000000|Logan city, UT
G|CT4947290000000|Magna metro township, UT
G|CT4949710000000|Midvale city, UT
G|CT4950150000000|Millcreek city, UT
G|CT4953230000000|Murray city, UT
G|CT4955980000000|Ogden city, UT
G|CT4957300000000|Orem city, UT
G|CT4960930000000|Pleasant Grove city, UT
G|CT4962470000000|Provo city, UT
G|CT4964340000000|Riverton city, UT
G|CT4965110000000|Roy city, UT
G|CT4965330000000|St. George city, UT
G|CT4967000000000|Salt Lake City city, UT
G|CT4967440000000|Sandy city, UT
G|CT4967825000000|Saratoga Springs city, UT
G|CT4970850000000|South Jordan city, UT
G|CT4971070000000|South Salt Lake city, UT
G|CT4971290000000|Spanish Fork city, UT
G|CT4972280000000|Springville city, UT
G|CT4974810000000|Syracuse city, UT
G|CT4975360000000|Taylorsville city, UT
G|CT4976680000000|Tooele city, UT
G|CT4981960000000|Washington city, UT
G|CT4982950000000|West Jordan city, UT
G|CT4983470000000|West Valley City city, UT
G|CT5010675000000|Burlington city, VT
G|CT5101000000000|Alexandria city, VA
G|CT5107784000000|Blacksburg town, VA
G|CT5109816000000|Bristol city, VA
G|CT5111032000000|Buena Vista city, VA
G|CT5114968000000|Charlottesville city, VA
G|CT5116000000000|Chesapeake city, VA
G|CT5118448000000|Colonial Heights city, VA
G|CT5119728000000|Covington city, VA
G|CT5121344000000|Danville city, VA
G|CT5125808000000|Emporia city, VA
G|CT5126496000000|Fairfax city, VA
G|CT5127200000000|Falls Church city, VA
G|CT5129600000000|Franklin city, VA
G|CT5129744000000|Fredericksburg city, VA
G|CT5130208000000|Galax city, VA
G|CT5135000000000|Hampton city, VA
G|CT5135624000000|Harrisonburg city, VA
G|CT5136648000000|Herndon town, VA
G|CT5138424000000|Hopewell city, VA
G|CT5144984000000|Leesburg town, VA
G|CT5145512000000|Lexington city, VA
G|CT5147672000000|Lynchburg city, VA
G|CT5148952000000|Manassas city, VA
G|CT5148968000000|Manassas Park city, VA
G|CT5149784000000|Martinsville city, VA
G|CT5156000000000|Newport News city, VA
G|CT5157000000000|Norfolk city, VA
G|CT5157688000000|Norton city, VA
G|CT5161832000000|Petersburg city, VA
G|CT5163768000000|Poquoson city, VA
G|CT5164000000000|Portsmouth city, VA
G|CT5165392000000|Radford city, VA
G|CT5167000000000|Richmond city, VA
G|CT5168000000000|Roanoke city, VA
G|CT5170000000000|Salem city, VA
G|CT5175216000000|Staunton city, VA
G|CT5176432000000|Suffolk city, VA
G|CT5182000000000|Virginia Beach city, VA
G|CT5183680000000|Waynesboro city, VA
G|CT5186160000000|Williamsburg city, VA
G|CT5186720000000|Winchester city, VA
G|CT5303180000000|Auburn city, WA
G|CT5303736000000|Bainbridge Island city, WA
G|CT5305210000000|Bellevue city, WA
G|CT5305280000000|Bellingham city, WA
G|CT5307380000000|Bothell city, WA
G|CT5307695000000|Bremerton city, WA
G|CT5308850000000|Burien city, WA
G|CT5309480000000|Camas city, WA
G|CT5317635000000|Des Moines city, WA
G|CT5320750000000|Edmonds city, WA
G|CT5322640000000|Everett city, WA
G|CT5323515000000|Federal Way city, WA
G|CT5333805000000|Issaquah city, WA
G|CT5335275000000|Kennewick city, WA
G|CT5335415000000|Kent city, WA
G|CT5335940000000|Kirkland city, WA
G|CT5336745000000|Lacey city, WA
G|CT5337900000000|Lake Stevens city, WA
G|CT5338038000000|Lakewood city, WA
G|CT5340245000000|Longview city, WA
G|CT5340840000000|Lynnwood city, WA
G|CT5343150000000|Maple Valley city, WA
G|CT5343955000000|Marysville city, WA
G|CT5345005000000|Mercer Island city, WA
G|CT5347245000000|Moses Lake city, WA
G|CT5347490000000|Mountlake Terrace city, WA
G|CT5347560000000|Mount Vernon city, WA
G|CT5351300000000|Olympia city, WA
G|CT5353545000000|Pasco city, WA
G|CT5356625000000|Pullman city, WA
G|CT5356695000000|Puyallup city, WA
G|CT5357535000000|Redmond city, WA
G|CT5357745000000|Renton city, WA
G|CT5358235000000|Richland city, WA
G|CT5361115000000|Sammamish city, WA
G|CT5362288000000|SeaTac city, WA
G|CT5363000000000|Seattle city, WA
G|CT5363960000000|Shoreline city, WA
G|CT5367000000000|Spokane city, WA
G|CT5367167000000|Spokane Valley city, WA
G|CT5370000000000|Tacoma city, WA
G|CT5372905000000|Tumwater city, WA
G|CT5373465000000|University Place city, WA
G|CT5374060000000|Vancouver city, WA
G|CT5375775000000|Walla Walla city, WA
G|CT5377105000000|Wenatchee city, WA
G|CT5380010000000|Yakima city, WA
G|CT5414600000000|Charleston city, WV
G|CT5439460000000|Huntington city, WV
G|CT5455756000000|Morgantown city, WV
G|CT5462140000000|Parkersburg city, WV
G|CT5486452000000|Wheeling city, WV
G|CT5502375000000|Appleton city, WI
G|CT5506500000000|Beloit city, WI
G|CT5510025000000|Brookfield city, WI
G|CT5511950000000|Caledonia village, WI
G|CT5519775000000|De Pere city, WI
G|CT5522300000000|Eau Claire city, WI
G|CT5525950000000|Fitchburg city, WI
G|CT5526275000000|Fond du Lac city, WI
G|CT5527300000000|Franklin city, WI
G|CT5531000000000|Green Bay city, WI
G|CT5531175000000|Greenfield city, WI
G|CT5537825000000|Janesville city, WI
G|CT5539225000000|Kenosha city, WI
G|CT5540775000000|La Crosse city, WI
G|CT5548000000000|Madison city, WI
G|CT5548500000000|Manitowoc city, WI
G|CT5551000000000|Menomonee Falls village, WI
G|CT5551150000000|Mequon city, WI
G|CT5553000000000|Milwaukee city, WI
G|CT5554875000000|Mount Pleasant village, WI
G|CT5555275000000|Muskego city, WI
G|CT5555750000000|Neenah city, WI
G|CT5556375000000|New Berlin city, WI
G|CT5558800000000|Oak Creek city, WI
G|CT5560500000000|Oshkosh city, WI
G|CT5566000000000|Racine city, WI
G|CT5572975000000|Sheboygan city, WI
G|CT5577200000000|Stevens Point city, WI
G|CT5578600000000|Sun Prairie city, WI
G|CT5578650000000|Superior city, WI
G|CT5584250000000|Waukesha city, WI
G|CT5584475000000|Wausau city, WI
G|CT5584675000000|Wauwatosa city, WI
G|CT5585300000000|West Allis city, WI
G|CT5585350000000|West Bend city, WI
G|CT5613150000000|Casper city, WY
G|CT5613900000000|Cheyenne city, WY
G|CT5631855000000|Gillette city, WY
G|CT5645050000000|Laramie city, WY
H|CS0901080000000|Andover town, CT
H|CS0901430000000|Ashford town, CT
H|CS0902060000000|Avon town, CT
H|CS0902760000000|Barkhamsted town, CT
H|CS0903250000000|Beacon Falls town, CT
H|CS0904300000000|Berlin town, CT
H|CS0904580000000|Bethany town, CT
H|CS0904720000000|Bethel town, CT
H|CS0904930000000|Bethlehem town, CT
H|CS0905910000000|Bloomfield town, CT
H|CS0906260000000|Bolton town, CT
H|CS0906820000000|Bozrah town, CT
H|CS0908210000000|Bridgewater town, CT
H|CS0908980000000|Brookfield town, CT
H|CS0909190000000|Brooklyn town, CT
H|CS0910100000000|Burlington town, CT
H|CS0910940000000|Canaan town, CT
H|CS0912130000000|Canterbury town, CT
H|CS0912270000000|Canton town, CT
H|CS0913810000000|Chaplin town, CT
H|CS0914300000000|Chester town, CT
H|CS0915350000000|Clinton town, CT
H|CS0915910000000|Colchester town, CT
H|CS0916050000000|Colebrook town, CT
H|CS0916400000000|Columbia town, CT
H|CS0917240000000|Cornwall town, CT
H|CS0917800000000|Coventry town, CT
H|CS0918080000000|Cromwell town, CT
H|CS0918850000000|Darien town, CT
H|CS0919130000000|Deep River town, CT
H|CS0920810000000|Durham town, CT
H|CS0921860000000|Eastford town, CT
H|CS0922070000000|East Granby town, CT
H|CS0922280000000|East Haddam town, CT
H|CS0922490000000|East Hampton town, CT
H|CS0923400000000|East Lyme town, CT
H|CS0923890000000|Easton town, CT
H|CS0924800000000|East Windsor town, CT
H|CS0925360000000|Ellington town, CT
H|CS0926270000000|Essex town, CT
H|CS0929910000000|Franklin town, CT
H|CS0932290000000|Goshen town, CT
H|CS0932640000000|Granby town, CT
H|CS0933900000000|Griswold town, CT
H|CS0934950000000|Guilford town, CT
H|CS0935230000000|Haddam town, CT
H|CS0936000000000|Hampton town, CT
H|CS0937140000000|Hartland town, CT
H|CS0937280000000|Harwinton town, CT
H|CS0937910000000|Hebron town, CT
H|CS0940290000000|Kent town, CT
H|CS0940500000000|Killingly town, CT
H|CS0940710000000|Killingworth town, CT
H|CS0942390000000|Lebanon town, CT
H|CS0942600000000|Ledyard town, CT
H|CS0943230000000|Lisbon town, CT
H|CS0943370000000|Litchfield town, CT
H|CS0944210000000|Lyme town, CT
H|CS0944560000000|Madison town, CT
H|CS0945820000000|Marlborough town, CT
H|CS0946940000000|Middlebury town, CT
H|CS0947080000000|Middlefield town, CT
H|CS0948620000000|Monroe town, CT
H|CS0948900000000|Montville town, CT
H|CS0949460000000|Morris town, CT
H|CS0950580000000|New Canaan town, CT
H|CS0950860000000|New Fairfield town, CT
H|CS0951350000000|New Hartford town, CT
H|CS0953470000000|Norfolk town, CT
H|CS0953890000000|North Branford town, CT
H|CS0954030000000|North Canaan town, CT
H|CS0954870000000|North Haven town, CT
H|CS0955500000000|North Stonington town, CT
H|CS0957040000000|Old Lyme town, CT
H|CS0957320000000|Old Saybrook town, CT
H|CS0957600000000|Orange town, CT
H|CS0958300000000|Oxford town, CT
H|CS0959980000000|Plainfield town, CT
H|CS0960120000000|Plainville town, CT
H|CS0960750000000|Plymouth town, CT
H|CS0961030000000|Pomfret town, CT
H|CS0961800000000|Portland town, CT
H|CS0962150000000|Preston town, CT
H|CS0962290000000|Prospect town, CT
H|CS0962710000000|Putnam town, CT
H|CS0963480000000|Redding town, CT
H|CS0965370000000|Rocky Hill town, CT
H|CS0965930000000|Roxbury town, CT
H|CS0966210000000|Salem town, CT
H|CS0966420000000|Salisbury town, CT
H|CS0967400000000|Scotland town, CT
H|CS0967610000000|Seymour town, CT
H|CS0967960000000|Sharon town, CT
H|CS0968310000000|Sherman town, CT
H|CS0968940000000|Simsbury town, CT
H|CS0969220000000|Somers town, CT
H|CS0969640000000|Southbury town, CT
H|CS0971670000000|Sprague town, CT
H|CS0972090000000|Stafford town, CT
H|CS0973420000000|Sterling town, CT
H|CS0973770000000|Stonington town, CT
H|CS0974540000000|Suffield town, CT
H|CS0975730000000|Thomaston town, CT
H|CS0975870000000|Thompson town, CT
H|CS0976290000000|Tolland town, CT
H|CS0977830000000|Union town, CT
H|CS0978600000000|Voluntown town, CT
H|CS0979510000000|Warren town, CT
H|CS0979720000000|Washington town, CT
H|CS0980280000000|Waterford town, CT
H|CS0980490000000|Watertown town, CT
H|CS0981680000000|Westbrook town, CT
H|CS0983430000000|Weston town, CT
H|CS0985950000000|Willington town, CT
H|CS0986370000000|Wilton town, CT
H|CS0986440000000|Winchester town, CT
H|CS0986790000000|Windham town, CT
H|CS0987070000000|Windsor Locks town, CT
H|CS0987560000000|Wolcott town, CT
H|CS0987700000000|Woodbridge town, CT
H|CS0987910000000|Woodbury town, CT
H|CS0988190000000|Woodstock town, CT
H|CS2300100000000|Abbot town, ME
H|CS2300275000000|Acton town, ME
H|CS2300380000000|Addison town, ME
H|CS2300590000000|Albion town, ME
H|CS2300660000000|Alexander town, ME
H|CS2300730000000|Alfred town, ME
H|CS2300800000000|Allagash town, ME
H|CS2301010000000|Alna town, ME
H|CS2301115000000|Alton town, ME
H|CS2301185000000|Amherst town, ME
H|CS2301220000000|Amity town, ME
H|CS2301325000000|Andover town, ME
H|CS2301395000000|Anson town, ME
H|CS2301465000000|Appleton town, ME
H|CS2301500000000|Argyle unorganized, ME
H|CS2301570000000|Arrowsic town, ME
H|CS2301605000000|Arundel town, ME
H|CS2301710000000|Ashland town, ME
H|CS2301885000000|Athens town, ME
H|CS2302165000000|Aurora town, ME
H|CS2302235000000|Avon town, ME
H|CS2302480000000|Baileyville town, ME
H|CS2302655000000|Baldwin town, ME
H|CS2302762000000|Bancroft unorganized, ME
H|CS2302865000000|Bar Harbor town, ME
H|CS2302970000000|Baring plantation, ME
H|CS2303670000000|Beals town, ME
H|CS2303740000000|Beaver Cove town, ME
H|CS2303810000000|Beddington town, ME
H|CS2304020000000|Belgrade town, ME
H|CS2304125000000|Belmont town, ME
H|CS2304475000000|Benton town, ME
H|CS2304720000000|Berwick town, ME
H|CS2304825000000|Bethel town, ME
H|CS2305000000000|Bingham town, ME
H|CS2305385000000|Blaine town, ME
H|CS2305560000000|Blanchard unorganized, ME
H|CS2305700000000|Blue Hill town, ME
H|CS2306050000000|Boothbay town, ME
H|CS2306120000000|Boothbay Harbor town, ME
H|CS2306260000000|Bowdoin town, ME
H|CS2306365000000|Bowdoinham town, ME
H|CS2306400000000|Bowerbank town, ME
H|CS2306575000000|Bradford town, ME
H|CS2306680000000|Bradley town, ME
H|CS2306855000000|Bremen town, ME
H|CS2307065000000|Bridgewater town, ME
H|CS2307170000000|Bridgton town, ME
H|CS2307380000000|Brighton plantation, ME
H|CS2307485000000|Bristol town, ME
H|CS2307800000000|Brooklin town, ME
H|CS2307870000000|Brooks town, ME
H|CS2307975000000|Brooksville town, ME
H|CS2308150000000|Brownfield town, ME
H|CS2308325000000|Brownville town, ME
H|CS2308430000000|Brunswick town, ME
H|CS2308710000000|Buckfield town, ME
H|CS2308815000000|Bucksport town, ME
H|CS2309200000000|Burlington town, ME
H|CS2309270000000|Burnham town, ME
H|CS2309410000000|Buxton town, ME
H|CS2309550000000|Byron town, ME
H|CS2309655000000|Cambridge town, ME
H|CS2309725000000|Camden town, ME
H|CS2309935000000|Canaan town, ME
H|CS2310005000000|Canton town, ME
H|CS2310180000000|Cape Elizabeth town, ME
H|CS2310495000000|Caratunk town, ME
H|CS2310670000000|Carmel town, ME
H|CS2310740000000|Carrabassett Valley town, ME
H|CS2310810000000|Carroll plantation, ME
H|CS2310915000000|Carthage town, ME
H|CS2311125000000|Casco town, ME
H|CS2311265000000|Castine town, ME
H|CS2311300000000|Castle Hill town, ME
H|CS2311335000000|Caswell town, ME
H|CS2311785000000|Central Aroostook unorganized, ME
H|CS2311800000000|Central Hancock unorganized, ME
H|CS2311820000000|Central Somerset unorganized, ME
H|CS2312000000000|Chapman town, ME
H|CS2312105000000|Charleston town, ME
H|CS2312175000000|Charlotte town, ME
H|CS2312300000000|Chebeague Island town, ME
H|CS2312350000000|Chelsea town, ME
H|CS2312455000000|Cherryfield town, ME
H|CS2312525000000|Chester town, ME
H|CS2312595000000|Chesterville town, ME
H|CS2312735000000|China town, ME
H|CS2313365000000|Clifton town, ME
H|CS2313470000000|Clinton town, ME
H|CS2313612000000|Codyville unorganized, ME
H|CS2313750000000|Columbia town, ME
H|CS2313820000000|Columbia Falls town, ME
H|CS2313900000000|Connor unorganized, ME
H|CS2314100000000|Cooper town, ME
H|CS2314205000000|Coplin plantation, ME
H|CS2314310000000|Corinna town, ME
H|CS2314380000000|Corinth town, ME
H|CS2314485000000|Cornish town, ME
H|CS2314555000000|Cornville town, ME
H|CS2314905000000|Cranberry Isles town, ME
H|CS2314940000000|Crawford town, ME
H|CS2315395000000|Crystal town, ME
H|CS2315430000000|Cumberland town, ME
H|CS2315780000000|Cushing town, ME
H|CS2315920000000|Cutler town, ME
H|CS2315990000000|Cyr plantation, ME
H|CS2316165000000|Dallas plantation, ME
H|CS2316235000000|Damariscotta town, ME
H|CS2316410000000|Danforth town, ME
H|CS2316725000000|Dayton town, ME
H|CS2316865000000|Deblois town, ME
H|CS2316935000000|Dedham town, ME
H|CS2317145000000|Deer Isle town, ME
H|CS2317250000000|Denmark town, ME
H|CS2317285000000|Dennistown plantation, ME
H|CS2317355000000|Dennysville town, ME
H|CS2317460000000|Detroit town, ME
H|CS2317530000000|Dexter town, ME
H|CS2317740000000|Dixfield town, ME
H|CS2317950000000|Dixmont town, ME
H|CS2318195000000|Dover-Foxcroft town, ME
H|CS2318475000000|Dresden town, ME
H|CS2318582000000|Drew unorganized, ME
H|CS2319105000000|Durham town, ME
H|CS2319210000000|Dyer Brook town, ME
H|CS2319420000000|Eagle Lake town, ME
H|CS2319770000000|Eastbrook town, ME
H|CS2319865000000|East Central Franklin unorganized, ME
H|CS2319868000000|East Central Penobscot unorganized, ME
H|CS2319870000000|East Central Washington unorganized, ME
H|CS2320405000000|East Hancock unorganized, ME
H|CS2320960000000|East Machias town, ME
H|CS2321030000000|East Millinocket town, ME
H|CS2321380000000|Easton town, ME
H|CS2322535000000|Eddington town, ME
H|CS2322675000000|Edgecomb town, ME
H|CS2322710000000|Edinburg town, ME
H|CS2322955000000|Eliot town, ME
H|CS2323410000000|Embden town, ME
H|CS2323620000000|Enfield town, ME
H|CS2323865000000|Etna town, ME
H|CS2324005000000|Eustis town, ME
H|CS2324110000000|Exeter town, ME
H|CS2324320000000|Fairfield town, ME
H|CS2324495000000|Falmouth town, ME
H|CS2324670000000|Farmingdale town, ME
H|CS2324775000000|Farmington town, ME
H|CS2324950000000|Fayette town, ME
H|CS2325615000000|Fort Fairfield town, ME
H|CS2325755000000|Fort Kent town, ME
H|CS2326280000000|Frankfort town, ME
H|CS2326350000000|Franklin town, ME
H|CS2326420000000|Freedom town, ME
H|CS2326525000000|Freeport town, ME
H|CS2326595000000|Frenchboro town, ME
H|CS2326735000000|Frenchville town, ME
H|CS2326805000000|Friendship town, ME
H|CS2326910000000|Fryeburg town, ME
H|CS2327025000000|Frye Island town, ME
H|CS2327120000000|Garfield plantation, ME
H|CS2327190000000|Garland town, ME
H|CS2327295000000|Georgetown town, ME
H|CS2327505000000|Gilead town, ME
H|CS2327645000000|Glenburn town, ME
H|CS2327855000000|Glenwood plantation, ME
H|CS2328240000000|Gorham town, ME
H|CS2328450000000|Gouldsboro town, ME
H|CS2328590000000|Grand Isle town, ME
H|CS2328660000000|Grand Lake Stream plantation, ME
H|CS2328870000000|Gray town, ME
H|CS2328975000000|Great Pond town, ME
H|CS2329185000000|Greenbush town, ME
H|CS2329255000000|Greene town, ME
H|CS2329535000000|Greenville town, ME
H|CS2329710000000|Greenwood town, ME
H|CS2330095000000|Guilford town, ME
H|CS2330690000000|Hamlin town, ME
H|CS2330725000000|Hammond town, ME
H|CS2330795000000|Hampden town, ME
H|CS2330970000000|Hancock town, ME
H|CS2331110000000|Hanover town, ME
H|CS2331355000000|Harmony town, ME
H|CS2331390000000|Harpswell town, ME
H|CS2331530000000|Harrington town, ME
H|CS2331600000000|Harrison town, ME
H|CS2331670000000|Hartford town, ME
H|CS2331740000000|Hartland town, ME
H|CS2332195000000|Haynesville town, ME
H|CS2332370000000|Hebron town, ME
H|CS2332510000000|Hermon town, ME
H|CS2332685000000|Hersey town, ME
H|CS2332715000000|Hibberts gore, ME
H|CS2332895000000|Highland plantation, ME
H|CS2333315000000|Hiram town, ME
H|CS2333385000000|Hodgdon town, ME
H|CS2333490000000|Holden town, ME
H|CS2333665000000|Hollis town, ME
H|CS2333840000000|Hope town, ME
H|CS2333980000000|Houlton town, ME
H|CS2334190000000|Howland town, ME
H|CS2334365000000|Hudson town, ME
H|CS2334820000000|Industry town, ME
H|CS2335065000000|Island Falls town, ME
H|CS2335135000000|Isle au Haut town, ME
H|CS2335240000000|Islesboro town, ME
H|CS2335345000000|Jackman town, ME
H|CS2335450000000|Jackson town, ME
H|CS2335625000000|Jay town, ME
H|CS2335695000000|Jefferson town, ME
H|CS2335905000000|Jonesboro town, ME
H|CS2336010000000|Jonesport town, ME
H|CS2336325000000|Kenduskeag town, ME
H|CS2336535000000|Kennebunk town, ME
H|CS2336745000000|Kennebunkport town, ME
H|CS2337025000000|Kingfield town, ME
H|CS2337075000000|Kingman unorganized, ME
H|CS2337095000000|Kingsbury plantation, ME
H|CS2337270000000|Kittery town, ME
H|CS2337585000000|Knox town, ME
H|CS2337760000000|Lagrange town, ME
H|CS2337970000000|Lake View plantation, ME
H|CS2338005000000|Lakeville town, ME
H|CS2338180000000|Lamoine town, ME
H|CS2338425000000|Lebanon town, ME
H|CS2338530000000|Lee town, ME
H|CS2338565000000|Leeds town, ME
H|CS2338705000000|Levant town, ME
H|CS2339055000000|Liberty town, ME
H|CS2339195000000|Limerick town, ME
H|CS2339300000000|Limestone town, ME
H|CS2339405000000|Limington town, ME
H|CS2339422000000|Lincoln plantation, ME
H|CS2339475000000|Lincoln town, ME
H|CS2339755000000|Lincolnville town, ME
H|CS2339965000000|Linneus town, ME
H|CS2340035000000|Lisbon town, ME
H|CS2340175000000|Litchfield town, ME
H|CS2340595000000|Littleton town, ME
H|CS2340665000000|Livermore town, ME
H|CS2340770000000|Livermore Falls town, ME
H|CS2341067000000|Long Island town, ME
H|CS2341365000000|Lovell town, ME
H|CS2341435000000|Lowell town, ME
H|CS2341610000000|Lubec town, ME
H|CS2341715000000|Ludlow town, ME
H|CS2341750000000|Lyman town, ME
H|CS2341960000000|Machias town, ME
H|CS2342100000000|Machiasport town, ME
H|CS2342450000000|Macwahoc plantation, ME
H|CS2342520000000|Madawaska town, ME
H|CS2342660000000|Madison town, ME
H|CS2343080000000|Manchester town, ME
H|CS2343255000000|Mapleton town, ME
H|CS2343430000000|Mariaville town, ME
H|CS2343640000000|Marshfield town, ME
H|CS2343710000000|Mars Hill town, ME
H|CS2343990000000|Masardis town, ME
H|CS2344165000000|Matinicus Isle plantation, ME
H|CS2344270000000|Mattawamkeag town, ME
H|CS2344340000000|Maxfield town, ME
H|CS2344585000000|Mechanic Falls town, ME
H|CS2344760000000|Meddybemps town, ME
H|CS2344830000000|Medford town, ME
H|CS2345005000000|Medway town, ME
H|CS2345110000000|Mercer town, ME
H|CS2345180000000|Merrill town, ME
H|CS2345285000000|Mexico town, ME
H|CS2345600000000|Milbridge town, ME
H|CS2345670000000|Milford town, ME
H|CS2345810000000|Millinocket town, ME
H|CS2346020000000|Milo town, ME
H|CS2346105000000|Milton unorganized, ME
H|CS2346160000000|Minot town, ME
H|CS2346335000000|Monhegan plantation, ME
H|CS2346405000000|Monmouth town, ME
H|CS2346475000000|Monroe town, ME
H|CS2346580000000|Monson town, ME
H|CS2346685000000|Monticello town, ME
H|CS2346790000000|Montville town, ME
H|CS2347140000000|Moose River town, ME
H|CS2347175000000|Moro plantation, ME
H|CS2347245000000|Morrill town, ME
H|CS2347455000000|Moscow town, ME
H|CS2347560000000|Mount Chase town, ME
H|CS2347630000000|Mount Desert town, ME
H|CS2347770000000|Mount Vernon town, ME
H|CS2348085000000|Naples town, ME
H|CS2348120000000|Nashville plantation, ME
H|CS2348505000000|Newburgh town, ME
H|CS2348575000000|New Canada town, ME
H|CS2348645000000|Newcastle town, ME
H|CS2348750000000|Newfield town, ME
H|CS2348820000000|New Gloucester town, ME
H|CS2348960000000|New Limerick town, ME
H|CS2349065000000|Newport town, ME
H|CS2349205000000|New Portland town, ME
H|CS2349275000000|Newry town, ME
H|CS2349345000000|New Sharon town, ME
H|CS2349415000000|New Sweden town, ME
H|CS2349520000000|New Vineyard town, ME
H|CS2349660000000|Nobleboro town, ME
H|CS2349835000000|Norridgewock town, ME
H|CS2350325000000|North Berwick town, ME
H|CS2351105000000|Northeast Piscataquis unorganized, ME
H|CS2351114000000|Northeast Somerset unorganized, ME
H|CS2351375000000|Northfield town, ME
H|CS2351400000000|North Franklin unorganized, ME
H|CS2351620000000|North Haven town, ME
H|CS2352575000000|North Oxford unorganized, ME
H|CS2352710000000|North Penobscot unorganized, ME
H|CS2352845000000|Northport town, ME
H|CS2353500000000|North Washington unorganized, ME
H|CS2353602000000|Northwest Aroostook unorganized, ME
H|CS2353620000000|Northwest Hancock unorganized, ME
H|CS2353628000000|Northwest Piscataquis unorganized, ME
H|CS2353636000000|Northwest Somerset unorganized, ME
H|CS2353860000000|North Yarmouth town, ME
H|CS2354000000000|Norway town, ME
H|CS2354385000000|Oakfield town, ME
H|CS2354560000000|Oakland town, ME
H|CS2354980000000|Ogunquit town, ME
H|CS2355085000000|Old Orchard Beach town, ME
H|CS2355435000000|Orient town, ME
H|CS2355505000000|Orland town, ME
H|CS2355565000000|Orono town, ME
H|CS2355680000000|Orrington town, ME
H|CS2355855000000|Osborn town, ME
H|CS2355890000000|Otis town, ME
H|CS2355960000000|Otisfield town, ME
H|CS2356135000000|Owls Head town, ME
H|CS2356310000000|Oxford town, ME
H|CS2356450000000|Palermo town, ME
H|CS2356520000000|Palmyra town, ME
H|CS2356625000000|Paris town, ME
H|CS2356765000000|Parkman town, ME
H|CS2356870000000|Parsonsfield town, ME
H|CS2357045000000|Passadumkeag town, ME
H|CS2357082000000|Passamaquoddy Indian Township Reservation, ME
H|CS2357090000000|Passamaquoddy Pleasant Point Reservation, ME
H|CS2357150000000|Patten town, ME
H|CS2357780000000|Pembroke town, ME
H|CS2357920000000|Penobscot town, ME
H|CS2357936000000|Penobscot Indian Island Reservation, ME
H|CS2358060000000|Perham town, ME
H|CS2358165000000|Perry town, ME
H|CS2358270000000|Peru town, ME
H|CS2358445000000|Phillips town, ME
H|CS2358515000000|Phippsburg town, ME
H|CS2359005000000|Pittsfield town, ME
H|CS2359110000000|Pittston town, ME
H|CS2359705000000|Pleasant Ridge plantation, ME
H|CS2359950000000|Plymouth town, ME
H|CS2360020000000|Poland town, ME
H|CS2360300000000|Portage Lake town, ME
H|CS2360405000000|Porter town, ME
H|CS2360685000000|Pownal town, ME
H|CS2360790000000|Prentiss unorganized, ME
H|CS2361035000000|Princeton town, ME
H|CS2361210000000|Prospect town, ME
H|CS2361700000000|Randolph town, ME
H|CS2361840000000|Rangeley town, ME
H|CS2361875000000|Rangeley plantation, ME
H|CS2361945000000|Raymond town, ME
H|CS2362190000000|Readfield town, ME
H|CS2362400000000|Reed plantation, ME
H|CS2362645000000|Richmond town, ME
H|CS2362995000000|Ripley town, ME
H|CS2363275000000|Robbinston town, ME
H|CS2363660000000|Rockport town, ME
H|CS2363835000000|Rome town, ME
H|CS2363940000000|Roque Bluffs town, ME
H|CS2364185000000|Roxbury town, ME
H|CS2364290000000|Rumford town, ME
H|CS2364570000000|Sabattus town, ME
H|CS2364780000000|St. Agatha town, ME
H|CS2364850000000|St. Albans town, ME
H|CS2365025000000|St. Francis town, ME
H|CS2365130000000|St. George town, ME
H|CS2365200000000|St. John plantation, ME
H|CS2365655000000|Sandy River plantation, ME
H|CS2365865000000|Sangerville town, ME
H|CS2366145000000|Scarborough town, ME
H|CS2366565000000|Searsmont town, ME
H|CS2366635000000|Searsport town, ME
H|CS2366775000000|Sebago town, ME
H|CS2366950000000|Sebec town, ME
H|CS2367160000000|Seboeis plantation, ME
H|CS2367238000000|Seboomook Lake unorganized, ME
H|CS2367300000000|Sedgwick town, ME
H|CS2367475000000|Shapleigh town, ME
H|CS2367790000000|Sherman town, ME
H|CS2368140000000|Shirley town, ME
H|CS2368385000000|Sidney town, ME
H|CS2368910000000|Skowhegan town, ME
H|CS2369155000000|Smithfield town, ME
H|CS2369260000000|Smyrna town, ME
H|CS2369505000000|Solon town, ME
H|CS2369645000000|Somerville town, ME
H|CS2369750000000|Sorrento town, ME
H|CS2369930000000|South Aroostook unorganized, ME
H|CS2370030000000|South Berwick town, ME
H|CS2370240000000|South Bristol town, ME
H|CS2370655000000|Southeast Piscataquis unorganized, ME
H|CS2370760000000|South Franklin unorganized, ME
H|CS2371755000000|South Oxford unorganized, ME
H|CS2371955000000|Southport town, ME
H|CS2372585000000|South Thomaston town, ME
H|CS2372865000000|Southwest Harbor town, ME
H|CS2373250000000|Springfield town, ME
H|CS2373472000000|Square Lake unorganized, ME
H|CS2373600000000|Stacyville town, ME
H|CS2373670000000|Standish town, ME
H|CS2373845000000|Starks town, ME
H|CS2374055000000|Stetson town, ME
H|CS2374125000000|Steuben town, ME
H|CS2374405000000|Stockholm town, ME
H|CS2374475000000|Stockton Springs town, ME
H|CS2374510000000|Stoneham town, ME
H|CS2374580000000|Stonington town, ME
H|CS2374685000000|Stow town, ME
H|CS2374825000000|Strong town, ME
H|CS2374965000000|Sullivan town, ME
H|CS2375035000000|Sumner town, ME
H|CS2375280000000|Surry town, ME
H|CS2375455000000|Swans Island town, ME
H|CS2375525000000|Swanville town, ME
H|CS2375595000000|Sweden town, ME
H|CS2375770000000|Talmadge town, ME
H|CS2375980000000|Temple town, ME
H|CS2376190000000|The Forks plantation, ME
H|CS2376365000000|Thomaston town, ME
H|CS2376610000000|Thorndike town, ME
H|CS2376895000000|Topsfield town, ME
H|CS2376960000000|Topsham town, ME
H|CS2377345000000|Tremont town, ME
H|CS2377415000000|Trenton town, ME
H|CS2377625000000|Troy town, ME
H|CS2377800000000|Turner town, ME
H|CS2378115000000|Union town, ME
H|CS2378190000000|Unity unorganized, ME
H|CS2378255000000|Unity town, ME
H|CS2378465000000|Upton town, ME
H|CS2378570000000|Van Buren town, ME
H|CS2378675000000|Vanceboro town, ME
H|CS2378745000000|Vassalboro town, ME
H|CS2378780000000|Veazie town, ME
H|CS2378925000000|Verona Island town, ME
H|CS2379025000000|Vienna town, ME
H|CS2379130000000|Vinalhaven town, ME
H|CS2379270000000|Wade town, ME
H|CS2379375000000|Waite town, ME
H|CS2379480000000|Waldo town, ME
H|CS2379550000000|Waldoboro town, ME
H|CS2379585000000|Wales town, ME
H|CS2379865000000|Wallagrass town, ME
H|CS2380040000000|Waltham town, ME
H|CS2380215000000|Warren town, ME
H|CS2380285000000|Washburn town, ME
H|CS2380425000000|Washington town, ME
H|CS2380530000000|Waterboro town, ME
H|CS2380635000000|Waterford town, ME
H|CS2380880000000|Wayne town, ME
H|CS2381055000000|Webster plantation, ME
H|CS2381300000000|Weld town, ME
H|CS2381405000000|Wellington town, ME
H|CS2381475000000|Wells town, ME
H|CS2381685000000|Wesley town, ME
H|CS2381930000000|West Bath town, ME
H|CS2382770000000|Westfield town, ME
H|CS2382840000000|West Forks plantation, ME
H|CS2382945000000|West Gardiner town, ME
H|CS2383540000000|Westmanland town, ME
H|CS2383785000000|Weston town, ME
H|CS2383890000000|West Paris town, ME
H|CS2384140000000|Westport Island town, ME
H|CS2385010000000|Whitefield town, ME
H|CS2385185000000|Whiting town, ME
H|CS2385290000000|Whitneyville town, ME
H|CS2385710000000|Willimantic town, ME
H|CS2385850000000|Wilton town, ME
H|CS2386025000000|Windham town, ME
H|CS2386165000000|Windsor town, ME
H|CS2386305000000|Winn town, ME
H|CS2386515000000|Winslow town, ME
H|CS2386655000000|Winter Harbor town, ME
H|CS2386760000000|Winterport town, ME
H|CS2386865000000|Winterville plantation, ME
H|CS2386970000000|Winthrop town, ME
H|CS2387075000000|Wiscasset town, ME
H|CS2387215000000|Woodland town, ME
H|CS2387355000000|Woodstock town, ME
H|CS2387390000000|Woodville town, ME
H|CS2387460000000|Woolwich town, ME
H|CS2387680000000|Wyman unorganized, ME
H|CS2387845000000|Yarmouth town, ME
H|CS2387985000000|York town, ME
H|CS2500170000000|Abington town, MA
H|CS2500380000000|Acton town, MA
H|CS2500520000000|Acushnet town, MA
H|CS2500555000000|Adams town, MA
H|CS2500975000000|Alford town, MA
H|CS2501585000000|Aquinnah town, MA
H|CS2501885000000|Ashburnham town, MA
H|CS2501955000000|Ashby town, MA
H|CS2502095000000|Ashfield town, MA
H|CS2502130000000|Ashland town, MA
H|CS2502480000000|Athol town, MA
H|CS2502760000000|Auburn town, MA
H|CS2502935000000|Avon town, MA
H|CS2503005000000|Ayer town, MA
H|CS2503740000000|Barre town, MA
H|CS2504545000000|Becket town, MA
H|CS2504615000000|Bedford town, MA
H|CS2504825000000|Belchertown town, MA
H|CS2504930000000|Bellingham town, MA
H|CS2505280000000|Berkley town, MA
H|CS2505490000000|Berlin town, MA
H|CS2505560000000|Bernardston town, MA
H|CS2506015000000|Blackstone town, MA
H|CS2506085000000|Blandford town, MA
H|CS2506365000000|Bolton town, MA
H|CS2507175000000|Bourne town, MA
H|CS2507350000000|Boxborough town, MA
H|CS2507420000000|Boxford town, MA
H|CS2507525000000|Boylston town, MA
H|CS2507980000000|Brewster town, MA
H|CS2508470000000|Brimfield town, MA
H|CS2509105000000|Brookfield town, MA
H|CS2509595000000|Buckland town, MA
H|CS2511315000000|Canton town, MA
H|CS2511525000000|Carlisle town, MA
H|CS2511665000000|Carver town, MA
H|CS2512505000000|Charlemont town, MA
H|CS2512715000000|Charlton town, MA
H|CS2512995000000|Chatham town, MA
H|CS2513345000000|Cheshire town, MA
H|CS2513485000000|Chester town, MA
H|CS2513590000000|Chesterfield town, MA
H|CS2513800000000|Chilmark town, MA
H|CS2514010000000|Clarksburg town, MA
H|CS2514395000000|Clinton town, MA
H|CS2514640000000|Cohasset town, MA
H|CS2514885000000|Colrain town, MA
H|CS2515060000000|Concord town, MA
H|CS2515200000000|Conway town, MA
H|CS2516040000000|Cummington town, MA
H|CS2516180000000|Dalton town, MA
H|CS2516670000000|Deerfield town, MA
H|CS2516775000000|Dennis town, MA
H|CS2516950000000|Dighton town, MA
H|CS2517300000000|Douglas town, MA
H|CS2517405000000|Dover town, MA
H|CS2517685000000|Dudley town, MA
H|CS2517825000000|Dunstable town, MA
H|CS2517895000000|Duxbury town, MA
H|CS2518455000000|East Bridgewater town, MA
H|CS2518560000000|East Brookfield town, MA
H|CS2519295000000|Eastham town, MA
H|CS2519645000000|East Longmeadow town, MA
H|CS2521150000000|Edgartown town, MA
H|CS2521360000000|Egremont town, MA
H|CS2521780000000|Erving town, MA
H|CS2521850000000|Essex town, MA
H|CS2522130000000|Fairhaven town, MA
H|CS2524120000000|Florida town, MA
H|CS2524820000000|Foxborough town, MA
H|CS2525240000000|Freetown town, MA
H|CS2525625000000|Georgetown town, MA
H|CS2525730000000|Gill town, MA
H|CS2526290000000|Goshen town, MA
H|CS2526325000000|Gosnold town, MA
H|CS2526430000000|Grafton town, MA
H|CS2526535000000|Granby town, MA
H|CS2526675000000|Granville town, MA
H|CS2526815000000|Great Barrington town, MA
H|CS2527480000000|Groton town, MA
H|CS2527620000000|Groveland town, MA
H|CS2527690000000|Hadley town, MA
H|CS2527795000000|Halifax town, MA
H|CS2527900000000|Hamilton town, MA
H|CS2528075000000|Hampden town, MA
H|CS2528180000000|Hancock town, MA
H|CS2528285000000|Hanover town, MA
H|CS2528495000000|Hanson town, MA
H|CS2528740000000|Hardwick town, MA
H|CS2528950000000|Harvard town, MA
H|CS2529020000000|Harwich town, MA
H|CS2529265000000|Hatfield town, MA
H|CS2529475000000|Hawley town, MA
H|CS2529650000000|Heath town, MA
H|CS2530210000000|Hingham town, MA
H|CS2530315000000|Hinsdale town, MA
H|CS2530455000000|Holbrook town, MA
H|CS2530560000000|Holden town, MA
H|CS2530665000000|Holland town, MA
H|CS2530700000000|Holliston town, MA
H|CS2530945000000|Hopedale town, MA
H|CS2531085000000|Hopkinton town, MA
H|CS2531435000000|Hubbardston town, MA
H|CS2531540000000|Hudson town, MA
H|CS2531645000000|Hull town, MA
H|CS2531785000000|Huntington town, MA
H|CS2532310000000|Ipswich town, MA
H|CS2533220000000|Kingston town, MA
H|CS2533920000000|Lakeville town, MA
H|CS2534165000000|Lancaster town, MA
H|CS2534340000000|Lanesborough town, MA
H|CS2534655000000|Lee town, MA
H|CS2534795000000|Leicester town, MA
H|CS2534970000000|Lenox town, MA
H|CS2535180000000|Leverett town, MA
H|CS2535285000000|Leyden town, MA
H|CS2535425000000|Lincoln town, MA
H|CS2535950000000|Littleton town, MA
H|CS2536300000000|Longmeadow town, MA
H|CS2537175000000|Ludlow town, MA
H|CS2537420000000|Lunenburg town, MA
H|CS2537560000000|Lynnfield town, MA
H|CS2537995000000|Manchester-by-the-Sea town, MA
H|CS2538225000000|Mansfield town, MA
H|CS2538400000000|Marblehead town, MA
H|CS2538540000000|Marion town, MA
H|CS2539100000000|Mashpee town, MA
H|CS2539450000000|Mattapoisett town, MA
H|CS2539625000000|Maynard town, MA
H|CS2539765000000|Medfield town, MA
H|CS2539975000000|Medway town, MA
H|CS2540255000000|Mendon town, MA
H|CS2540430000000|Merrimac town, MA
H|CS2540850000000|Middleborough town, MA
H|CS2540990000000|Middlefield town, MA
H|CS2541095000000|Middleton town, MA
H|CS2541340000000|Millbury town, MA
H|CS2541515000000|Millis town, MA
H|CS2541585000000|Millville town, MA
H|CS2542040000000|Monroe town, MA
H|CS2542145000000|Monson town, MA
H|CS2542285000000|Montague town, MA
H|CS2542460000000|Monterey town, MA
H|CS2542530000000|Montgomery town, MA
H|CS2543300000000|Mount Washington town, MA
H|CS2543580000000|Nahant town, MA
H|CS2543790000000|Nantucket County/town, MA
H|CS2544385000000|New Ashford town, MA
H|CS2545105000000|New Braintree town, MA
H|CS2545175000000|Newbury town, MA
H|CS2545420000000|New Marlborough town, MA
H|CS2545490000000|New Salem town, MA
H|CS2546050000000|Norfolk town, MA
H|CS2546820000000|Northborough town, MA
H|CS2546925000000|Northbridge town, MA
H|CS2547135000000|North Brookfield town, MA
H|CS2547835000000|Northfield town, MA
H|CS2548955000000|North Reading town, MA
H|CS2549970000000|Norton town, MA
H|CS2550145000000|Norwell town, MA
H|CS2550390000000|Oak Bluffs town, MA
H|CS2550670000000|Oakham town, MA
H|CS2551265000000|Orange town, MA
H|CS2551440000000|Orleans town, MA
H|CS2551580000000|Otis town, MA
H|CS2551825000000|Oxford town, MA
H|CS2552420000000|Paxton town, MA
H|CS2552560000000|Pelham town, MA
H|CS2552630000000|Pembroke town, MA
H|CS2552805000000|Pepperell town, MA
H|CS2553050000000|Peru town, MA
H|CS2553120000000|Petersham town, MA
H|CS2553225000000|Phillipston town, MA
H|CS2554030000000|Plainfield town, MA
H|CS2554100000000|Plainville town, MA
H|CS2554415000000|Plympton town, MA
H|CS2555395000000|Princeton town, MA
H|CS2555500000000|Provincetown town, MA
H|CS2556060000000|Raynham town, MA
H|CS2556375000000|Rehoboth town, MA
H|CS2556795000000|Richmond town, MA
H|CS2557600000000|Rochester town, MA
H|CS2557775000000|Rockland town, MA
H|CS2557880000000|Rockport town, MA
H|CS2558335000000|Rowe town, MA
H|CS2558405000000|Rowley town, MA
H|CS2558580000000|Royalston town, MA
H|CS2558650000000|Russell town, MA
H|CS2558825000000|Rutland town, MA
H|CS2559245000000|Salisbury town, MA
H|CS2559665000000|Sandisfield town, MA
H|CS2559735000000|Sandwich town, MA
H|CS2560225000000|Savoy town, MA
H|CS2560330000000|Scituate town, MA
H|CS2560645000000|Seekonk town, MA
H|CS2560785000000|Sharon town, MA
H|CS2561065000000|Sheffield town, MA
H|CS2561135000000|Shelburne town, MA
H|CS2561380000000|Sherborn town, MA
H|CS2561590000000|Shirley town, MA
H|CS2561905000000|Shutesbury town, MA
H|CS2562430000000|Somerset town, MA
H|CS2562745000000|Southampton town, MA
H|CS2563165000000|Southborough town, MA
H|CS2564145000000|South Hadley town, MA
H|CS2565825000000|Southwick town, MA
H|CS2566105000000|Spencer town, MA
H|CS2567385000000|Sterling town, MA
H|CS2567595000000|Stockbridge town, MA
H|CS2567665000000|Stoneham town, MA
H|CS2568050000000|Stow town, MA
H|CS2568155000000|Sturbridge town, MA
H|CS2568260000000|Sudbury town, MA
H|CS2568400000000|Sunderland town, MA
H|CS2568610000000|Sutton town, MA
H|CS2568645000000|Swampscott town, MA
H|CS2568750000000|Swansea town, MA
H|CS2569275000000|Templeton town, MA
H|CS2569940000000|Tisbury town, MA
H|CS2570045000000|Tolland town, MA
H|CS2570150000000|Topsfield town, MA
H|CS2570360000000|Townsend town, MA
H|CS2570605000000|Truro town, MA
H|CS2571025000000|Tyngsborough town, MA
H|CS2571095000000|Tyringham town, MA
H|CS2571480000000|Upton town, MA
H|CS2571620000000|Uxbridge town, MA
H|CS2572390000000|Wales town, MA
H|CS2572880000000|Ware town, MA
H|CS2572985000000|Wareham town, MA
H|CS2573090000000|Warren town, MA
H|CS2573265000000|Warwick town, MA
H|CS2573335000000|Washington town, MA
H|CS2573790000000|Wayland town, MA
H|CS2573895000000|Webster town, MA
H|CS2574385000000|Wellfleet town, MA
H|CS2574525000000|Wendell town, MA
H|CS2574595000000|Wenham town, MA
H|CS2575015000000|Westborough town, MA
H|CS2575155000000|West Boylston town, MA
H|CS2575260000000|West Bridgewater town, MA
H|CS2575400000000|West Brookfield town, MA
H|CS2576135000000|Westford town, MA
H|CS2576380000000|Westhampton town, MA
H|CS2577010000000|Westminster town, MA
H|CS2577150000000|West Newbury town, MA
H|CS2577255000000|Weston town, MA
H|CS2577570000000|Westport town, MA
H|CS2577990000000|West Stockbridge town, MA
H|CS2578235000000|West Tisbury town, MA
H|CS2578690000000|Westwood town, MA
H|CS2579110000000|Whately town, MA
H|CS2579530000000|Whitman town, MA
H|CS2579740000000|Wilbraham town, MA
H|CS2579915000000|Williamsburg town, MA
H|CS2579985000000|Williamstown town, MA
H|CS2580230000000|Wilmington town, MA
H|CS2580405000000|Winchendon town, MA
H|CS2580510000000|Winchester town, MA
H|CS2580685000000|Windsor town, MA
H|CS2582175000000|Worthington town, MA
H|CS2582315000000|Wrentham town, MA
H|CS3300260000000|Acworth town, NH
H|CS3300420000000|Albany town, NH
H|CS3300580000000|Alexandria town, NH
H|CS3300660000000|Allenstown town, NH
H|CS3300820000000|Alstead town, NH
H|CS3301060000000|Alton town, NH
H|CS3301300000000|Amherst town, NH
H|CS3301460000000|Andover town, NH
H|CS3301700000000|Antrim town, NH
H|CS3302020000000|Ashland town, NH
H|CS3302340000000|Atkinson town, NH
H|CS3302820000000|Auburn town, NH
H|CS3303220000000|Barnstead town, NH
H|CS3303460000000|Barrington town, NH
H|CS3303700000000|Bartlett town, NH
H|CS3303940000000|Bath town, NH
H|CS3304500000000|Bedford town, NH
H|CS3304740000000|Belmont town, NH
H|CS3304900000000|Bennington town, NH
H|CS3305060000000|Benton town, NH
H|CS3305460000000|Bethlehem town, NH
H|CS3306260000000|Boscawen town, NH
H|CS3306500000000|Bow town, NH
H|CS3306980000000|Bradford town, NH
H|CS3307220000000|Brentwood town, NH
H|CS3307540000000|Bridgewater town, NH
H|CS3307700000000|Bristol town, NH
H|CS3307940000000|Brookfield town, NH
H|CS3308100000000|Brookline town, NH
H|CS3308420000000|Cambridge township, NH
H|CS3308660000000|Campton town, NH
H|CS3308980000000|Canaan town, NH
H|CS3309300000000|Candia town, NH
H|CS3309860000000|Canterbury town, NH
H|CS3310100000000|Carroll town, NH
H|CS3310660000000|Center Harbor town, NH
H|CS3311380000000|Charlestown town, NH
H|CS3311780000000|Chatham town, NH
H|CS3312100000000|Chester town, NH
H|CS3312260000000|Chesterfield town, NH
H|CS3312420000000|Chichester town, NH
H|CS3313220000000|Clarksville town, NH
H|CS3313780000000|Colebrook town, NH
H|CS3313940000000|Columbia town, NH
H|CS3314660000000|Conway town, NH
H|CS3315060000000|Cornish town, NH
H|CS3316340000000|Croydon town, NH
H|CS3316820000000|Dalton town, NH
H|CS3316980000000|Danbury town, NH
H|CS3317140000000|Danville town, NH
H|CS3317460000000|Deerfield town, NH
H|CS3317780000000|Deering town, NH
H|CS3318420000000|Dixville township, NH
H|CS3318740000000|Dorchester town, NH
H|CS3319140000000|Dublin town, NH
H|CS3319300000000|Dummer town, NH
H|CS3319460000000|Dunbarton town, NH
H|CS3319700000000|Durham town, NH
H|CS3321380000000|East Kingston town, NH
H|CS3322020000000|Easton town, NH
H|CS3323380000000|Eaton town, NH
H|CS3323620000000|Effingham town, NH
H|CS3323860000000|Ellsworth town, NH
H|CS3324340000000|Enfield town, NH
H|CS3324660000000|Epping town, NH
H|CS3324900000000|Epsom town, NH
H|CS3325140000000|Errol town, NH
H|CS3325380000000|Exeter town, NH
H|CS3326020000000|Farmington town, NH
H|CS3326500000000|Fitzwilliam town, NH
H|CS3327140000000|Francestown town, NH
H|CS3327300000000|Franconia town, NH
H|CS3327700000000|Freedom town, NH
H|CS3327940000000|Fremont town, NH
H|CS3328740000000|Gilford town, NH
H|CS3328980000000|Gilmanton town, NH
H|CS3329220000000|Gilsum town, NH
H|CS3329860000000|Goffstown town, NH
H|CS3330260000000|Gorham town, NH
H|CS3330500000000|Goshen town, NH
H|CS3330820000000|Grafton town, NH
H|CS3331220000000|Grantham town, NH
H|CS3331540000000|Greenfield town, NH
H|CS3331700000000|Greenland town, NH
H|CS3331780000000|Greens grant, NH
H|CS3331940000000|Greenville town, NH
H|CS3332180000000|Groton town, NH
H|CS3332500000000|Hale's location, NH
H|CS3332900000000|Hampstead town, NH
H|CS3333060000000|Hampton town, NH
H|CS3333460000000|Hampton Falls town, NH
H|CS3333700000000|Hancock town, NH
H|CS3333860000000|Hanover town, NH
H|CS3334420000000|Harrisville town, NH
H|CS3334500000000|Hart's Location town, NH
H|CS3334820000000|Haverhill town, NH
H|CS3335220000000|Hebron town, NH
H|CS3335540000000|Henniker town, NH
H|CS3335860000000|Hill town, NH
H|CS3336180000000|Hillsborough town, NH
H|CS3336660000000|Hinsdale town, NH
H|CS3336900000000|Holderness town, NH
H|CS3337140000000|Hollis town, NH
H|CS3337300000000|Hooksett town, NH
H|CS3337540000000|Hopkinton town, NH
H|CS3338260000000|Jackson town, NH
H|CS3338500000000|Jaffrey town, NH
H|CS3338820000000|Jefferson town, NH
H|CS3339780000000|Kensington town, NH
H|CS3340100000000|Kingston town, NH
H|CS3340420000000|Lancaster town, NH
H|CS3340660000000|Landaff town, NH
H|CS3340900000000|Langdon town, NH
H|CS3341460000000|Lee town, NH
H|CS3341700000000|Lempster town, NH
H|CS3341860000000|Lincoln town, NH
H|CS3342020000000|Lisbon town, NH
H|CS3342260000000|Litchfield town, NH
H|CS3342580000000|Littleton town, NH
H|CS3343380000000|Loudon town, NH
H|CS3344100000000|Lyman town, NH
H|CS3344260000000|Lyme town, NH
H|CS3344580000000|Lyndeborough town, NH
H|CS3344820000000|Madbury town, NH
H|CS3345060000000|Madison town, NH
H|CS3345460000000|Marlborough town, NH
H|CS3345700000000|Marlow town, NH
H|CS3346260000000|Mason town, NH
H|CS3347140000000|Meredith town, NH
H|CS3347700000000|Middleton town, NH
H|CS3347860000000|Milan town, NH
H|CS3348020000000|Milford town, NH
H|CS3348260000000|Millsfield township, NH
H|CS3348660000000|Milton town, NH
H|CS3348980000000|Monroe town, NH
H|CS3349140000000|Mont Vernon town, NH
H|CS3349380000000|Moultonborough town, NH
H|CS3350580000000|Nelson town, NH
H|CS3350740000000|New Boston town, NH
H|CS3350900000000|Newbury town, NH
H|CS3350980000000|New Castle town, NH
H|CS3351220000000|New Durham town, NH
H|CS3351380000000|Newfields town, NH
H|CS3351540000000|New Hampton town, NH
H|CS3351620000000|Newington town, NH
H|CS3351940000000|New Ipswich town, NH
H|CS3352100000000|New London town, NH
H|CS3352340000000|Newmarket town, NH
H|CS3352580000000|Newport town, NH
H|CS3352900000000|Newton town, NH
H|CS3354260000000|Northfield town, NH
H|CS3354580000000|North Hampton town, NH
H|CS3356100000000|Northumberland town, NH
H|CS3356820000000|Northwood town, NH
H|CS3357460000000|Nottingham town, NH
H|CS3358340000000|Orange town, NH
H|CS3358500000000|Orford town, NH
H|CS3358740000000|Ossipee town, NH
H|CS3359940000000|Pelham town, NH
H|CS3360020000000|Pembroke town, NH
H|CS3360580000000|Peterborough town, NH
H|CS3361060000000|Piermont town, NH
H|CS3361620000000|Pinkhams grant, NH
H|CS3361780000000|Pittsburg town, NH
H|CS3361940000000|Pittsfield town, NH
H|CS3362340000000|Plainfield town, NH
H|CS3362500000000|Plaistow town, NH
H|CS3362660000000|Plymouth town, NH
H|CS3363860000000|Randolph town, NH
H|CS3364020000000|Raymond town, NH
H|CS3364420000000|Richmond town, NH
H|CS3364580000000|Rindge town, NH
H|CS3365540000000|Rollinsford town, NH
H|CS3365700000000|Roxbury town, NH
H|CS3365940000000|Rumney town, NH
H|CS3366180000000|Rye town, NH
H|CS3366980000000|Salisbury town, NH
H|CS3367300000000|Sanbornton town, NH
H|CS3367620000000|Sandown town, NH
H|CS3367780000000|Sandwich town, NH
H|CS3367860000000|Sargents purchase, NH
H|CS3368260000000|Seabrook town, NH
H|CS3368820000000|Sharon town, NH
H|CS3368980000000|Shelburne town, NH
H|CS3371140000000|South Hampton town, NH
H|CS3372740000000|Springfield town, NH
H|CS3373060000000|Stark town, NH
H|CS3373380000000|Stewartstown town, NH
H|CS3373700000000|Stoddard town, NH
H|CS3373860000000|Strafford town, NH
H|CS3374180000000|Stratford town, NH
H|CS3374340000000|Stratham town, NH
H|CS3374740000000|Sugar Hill town, NH
H|CS3374900000000|Sullivan town, NH
H|CS3375060000000|Sunapee town, NH
H|CS3375300000000|Surry town, NH
H|CS3375460000000|Sutton town, NH
H|CS3375700000000|Swanzey town, NH
H|CS3376100000000|Tamworth town, NH
H|CS3376260000000|Temple town, NH
H|CS3376740000000|Thornton town, NH
H|CS3377060000000|Tilton town, NH
H|CS3377380000000|Troy town, NH
H|CS3377620000000|Tuftonboro town, NH
H|CS3377940000000|Unity town, NH
H|CS3378180000000|Wakefield town, NH
H|CS3378420000000|Walpole town, NH
H|CS3378580000000|Warner town, NH
H|CS3378740000000|Warren town, NH
H|CS3378980000000|Washington town, NH
H|CS3379380000000|Waterville Valley town, NH
H|CS3379780000000|Weare town, NH
H|CS3380020000000|Webster town, NH
H|CS3380500000000|Wentworth town, NH
H|CS3380740000000|Wentworth location, NH
H|CS3382660000000|Westmoreland town, NH
H|CS3384420000000|Whitefield town, NH
H|CS3384900000000|Wilmot town, NH
H|CS3385220000000|Wilton town, NH
H|CS3385540000000|Winchester town, NH
H|CS3385780000000|Windham town, NH
H|CS3385940000000|Windsor town, NH
H|CS3386420000000|Wolfeboro town, NH
H|CS3387060000000|Woodstock town, NH
H|CS4405140000000|Barrington town, RI
H|CS4409280000000|Bristol town, RI
H|CS4411800000000|Burrillville town, RI
H|CS4414500000000|Charlestown town, RI
H|CS4422240000000|East Greenwich town, RI
H|CS4425300000000|Exeter town, RI
H|CS4427460000000|Foster town, RI
H|CS4430340000000|Glocester town, RI
H|CS4435380000000|Hopkinton town, RI
H|CS4436820000000|Jamestown town, RI
H|CS4441500000000|Lincoln town, RI
H|CS4442400000000|Little Compton town, RI
H|CS4445460000000|Middletown town, RI
H|CS4448340000000|Narragansett town, RI
H|CS4450500000000|New Shoreham town, RI
H|CS4452480000000|North Smithfield town, RI
H|CS4457880000000|Portsmouth town, RI
H|CS4461160000000|Richmond town, RI
H|CS4464220000000|Scituate town, RI
H|CS4466200000000|Smithfield town, RI
H|CS4470880000000|Tiverton town, RI
H|CS4473760000000|Warren town, RI
H|CS4477000000000|Westerly town, RI
H|CS4477720000000|West Greenwich town, RI
H|CS5000325000000|Addison town, VT
H|CS5000475000000|Albany town, VT
H|CS5000860000000|Alburgh town, VT
H|CS5001300000000|Andover town, VT
H|CS5001450000000|Arlington town, VT
H|CS5001900000000|Athens town, VT
H|CS5002125000000|Averill town, VT
H|CS5002500000000|Bakersfield town, VT
H|CS5002575000000|Baltimore town, VT
H|CS5002725000000|Barnard town, VT
H|CS5002875000000|Barnet town, VT
H|CS5003250000000|Barre town, VT
H|CS5003550000000|Barton town, VT
H|CS5004375000000|Belvidere town, VT
H|CS5004825000000|Bennington town, VT
H|CS5005200000000|Benson town, VT
H|CS5005425000000|Berkshire town, VT
H|CS5005650000000|Berlin town, VT
H|CS5005800000000|Bethel town, VT
H|CS5006325000000|Bloomfield town, VT
H|CS5006550000000|Bolton town, VT
H|CS5007375000000|Bradford town, VT
H|CS5007600000000|Braintree town, VT
H|CS5007750000000|Brandon town, VT
H|CS5007900000000|Brattleboro town, VT
H|CS5008275000000|Bridgewater town, VT
H|CS5008575000000|Bridport town, VT
H|CS5008725000000|Brighton town, VT
H|CS5009025000000|Bristol town, VT
H|CS5009325000000|Brookfield town, VT
H|CS5009475000000|Brookline town, VT
H|CS5009850000000|Brownington town, VT
H|CS5010075000000|Brunswick town, VT
H|CS5010300000000|Buels gore, VT
H|CS5010450000000|Burke town, VT
H|CS5011125000000|Cabot town, VT
H|CS5011350000000|Calais town, VT
H|CS5011500000000|Cambridge town, VT
H|CS5011800000000|Canaan town, VT
H|CS5011950000000|Castleton town, VT
H|CS5012250000000|Cavendish town, VT
H|CS5013150000000|Charleston town, VT
H|CS5013300000000|Charlotte town, VT
H|CS5013525000000|Chelsea town, VT
H|CS5013675000000|Chester town, VT
H|CS5014350000000|Chittenden town, VT
H|CS5014500000000|Clarendon town, VT
H|CS5014875000000|Colchester town, VT
H|CS5015250000000|Concord town, VT
H|CS5015700000000|Corinth town, VT
H|CS5016000000000|Cornwall town, VT
H|CS5016150000000|Coventry town, VT
H|CS5016300000000|Craftsbury town, VT
H|CS5016825000000|Danby town, VT
H|CS5017125000000|Danville town, VT
H|CS5017350000000|Derby town, VT
H|CS5017725000000|Dorset town, VT
H|CS5017875000000|Dover town, VT
H|CS5018325000000|Dummerston town, VT
H|CS5018550000000|Duxbury town, VT
H|CS5021250000000|East Haven town, VT
H|CS5021925000000|East Montpelier town, VT
H|CS5023500000000|Eden town, VT
H|CS5023725000000|Elmore town, VT
H|CS5024050000000|Enosburgh town, VT
H|CS5024175000000|Essex town, VT
H|CS5024925000000|Fairfax town, VT
H|CS5025225000000|Fairfield town, VT
H|CS5025375000000|Fair Haven town, VT
H|CS5025675000000|Fairlee town, VT
H|CS5025825000000|Fayston town, VT
H|CS5025975000000|Ferdinand town, VT
H|CS5026300000000|Ferrisburgh town, VT
H|CS5026500000000|Fletcher town, VT
H|CS5027100000000|Franklin town, VT
H|CS5027700000000|Georgia town, VT
H|CS5027962000000|Glastenbury town, VT
H|CS5028075000000|Glover town, VT
H|CS5028600000000|Goshen town, VT
H|CS5028900000000|Grafton town, VT
H|CS5029125000000|Granby town, VT
H|CS5029275000000|Grand Isle town, VT
H|CS5029575000000|Granville town, VT
H|CS5030175000000|Greensboro town, VT
H|CS5030550000000|Groton town, VT
H|CS5030775000000|Guildhall town, VT
H|CS5030925000000|Guilford town, VT
H|CS5031150000000|Halifax town, VT
H|CS5031525000000|Hancock town, VT
H|CS5031825000000|Hardwick town, VT
H|CS5032275000000|Hartford town, VT
H|CS5032425000000|Hartland town, VT
H|CS5033025000000|Highgate town, VT
H|CS5033475000000|Hinesburg town, VT
H|CS5033775000000|Holland town, VT
H|CS5034450000000|Hubbardton town, VT
H|CS5034600000000|Huntington town, VT
H|CS5035050000000|Hyde Park town, VT
H|CS5035425000000|Ira town, VT
H|CS5035575000000|Irasburg town, VT
H|CS5035875000000|Isle La Motte town, VT
H|CS5036175000000|Jamaica town, VT
H|CS5036325000000|Jay town, VT
H|CS5036700000000|Jericho town, VT
H|CS5037075000000|Johnson town, VT
H|CS5037685000000|Killington town, VT
H|CS5037900000000|Kirby town, VT
H|CS5039025000000|Landgrove town, VT
H|CS5039325000000|Leicester town, VT
H|CS5039700000000|Lemington town, VT
H|CS5040075000000|Lincoln town, VT
H|CS5040225000000|Londonderry town, VT
H|CS5040525000000|Lowell town, VT
H|CS5041275000000|Ludlow town, VT
H|CS5041425000000|Lunenburg town, VT
H|CS5041725000000|Lyndon town, VT
H|CS5042475000000|Maidstone town, VT
H|CS5042850000000|Manchester town, VT
H|CS5043375000000|Marlboro town, VT
H|CS5043600000000|Marshfield town, VT
H|CS5044125000000|Mendon town, VT
H|CS5044350000000|Middlebury town, VT
H|CS5044500000000|Middlesex town, VT
H|CS5044800000000|Middletown Springs town, VT
H|CS5045250000000|Milton town, VT
H|CS5045550000000|Monkton town, VT
H|CS5045850000000|Montgomery town, VT
H|CS5046225000000|Moretown town, VT
H|CS5046450000000|Morgan town, VT
H|CS5046675000000|Morristown town, VT
H|CS5047200000000|Mount Holly town, VT
H|CS5047425000000|Mount Tabor town, VT
H|CS5047725000000|Newark town, VT
H|CS5048175000000|Newbury town, VT
H|CS5048400000000|Newfane town, VT
H|CS5048700000000|New Haven town, VT
H|CS5048925000000|Newport town, VT
H|CS5050275000000|Northfield town, VT
H|CS5050650000000|North Hero town, VT
H|CS5052750000000|Norton town, VT
H|CS5052900000000|Norwich town, VT
H|CS5053425000000|Orange town, VT
H|CS5053725000000|Orwell town, VT
H|CS5053950000000|Panton town, VT
H|CS5054250000000|Pawlet town, VT
H|CS5054400000000|Peacham town, VT
H|CS5055000000000|Peru town, VT
H|CS5055450000000|Pittsfield town, VT
H|CS5055600000000|Pittsford town, VT
H|CS5055825000000|Plainfield town, VT
H|CS5056050000000|Plymouth town, VT
H|CS5056350000000|Pomfret town, VT
H|CS5056875000000|Poultney town, VT
H|CS5057025000000|Pownal town, VT
H|CS5057250000000|Proctor town, VT
H|CS5057700000000|Putney town, VT
H|CS5058075000000|Randolph town, VT
H|CS5058375000000|Reading town, VT
H|CS5058600000000|Readsboro town, VT
H|CS5059125000000|Richford town, VT
H|CS5059275000000|Richmond town, VT
H|CS5059650000000|Ripton town, VT
H|CS5060100000000|Rochester town, VT
H|CS5060250000000|Rockingham town, VT
H|CS5060625000000|Roxbury town, VT
H|CS5060850000000|Royalton town, VT
H|CS5061000000000|Rupert town, VT
H|CS5061300000000|Rutland town, VT
H|CS5061525000000|Ryegate town, VT
H|CS5061750000000|St. Albans town, VT
H|CS5062050000000|St. George town, VT
H|CS5062200000000|St. Johnsbury town, VT
H|CS5062575000000|Salisbury town, VT
H|CS5062875000000|Sandgate town, VT
H|CS5063175000000|Searsburg town, VT
H|CS5063550000000|Shaftsbury town, VT
H|CS5063775000000|Sharon town, VT
H|CS5064075000000|Sheffield town, VT
H|CS5064300000000|Shelburne town, VT
H|CS5064600000000|Sheldon town, VT
H|CS5065050000000|Shoreham town, VT
H|CS5065275000000|Shrewsbury town, VT
H|CS5067000000000|South Hero town, VT
H|CS5069550000000|Springfield town, VT
H|CS5069775000000|Stamford town, VT
H|CS5069925000000|Stannard town, VT
H|CS5070075000000|Starksboro town, VT
H|CS5070375000000|Stockbridge town, VT
H|CS5070525000000|Stowe town, VT
H|CS5070675000000|Strafford town, VT
H|CS5070750000000|Stratton town, VT
H|CS5071050000000|Sudbury town, VT
H|CS5071425000000|Sunderland town, VT
H|CS5071575000000|Sutton town, VT
H|CS5071725000000|Swanton town, VT
H|CS5072400000000|Thetford town, VT
H|CS5072925000000|Tinmouth town, VT
H|CS5073075000000|Topsham town, VT
H|CS5073300000000|Townshend town, VT
H|CS5073525000000|Troy town, VT
H|CS5073675000000|Tunbridge town, VT
H|CS5073975000000|Underhill town, VT
H|CS5074800000000|Vernon town, VT
H|CS5074950000000|Vershire town, VT
H|CS5075175000000|Victory town, VT
H|CS5075325000000|Waitsfield town, VT
H|CS5075700000000|Walden town, VT
H|CS5075925000000|Wallingford town, VT
H|CS5076075000000|Waltham town, VT
H|CS5076225000000|Wardsboro town, VT
H|CS5076525000000|Warren town, VT
H|CS5076562000000|Warren's gore, VT
H|CS5076750000000|Washington town, VT
H|CS5076975000000|Waterbury town, VT
H|CS5077125000000|Waterford town, VT
H|CS5077425000000|Waterville town, VT
H|CS5077500000000|Weathersfield town, VT
H|CS5077950000000|Wells town, VT
H|CS5079975000000|West Fairlee town, VT
H|CS5080200000000|Westfield town, VT
H|CS5080350000000|Westford town, VT
H|CS5080875000000|West Haven town, VT
H|CS5081400000000|Westminster town, VT
H|CS5081700000000|Westmore town, VT
H|CS5082000000000|Weston town, VT
H|CS5082300000000|West Rutland town, VT
H|CS5083050000000|West Windsor town, VT
H|CS5083275000000|Weybridge town, VT
H|CS5083500000000|Wheelock town, VT
H|CS5083800000000|Whiting town, VT
H|CS5083950000000|Whitingham town, VT
H|CS5084175000000|Williamstown town, VT
H|CS5084475000000|Williston town, VT
H|CS5084700000000|Wilmington town, VT
H|CS5084850000000|Windham town, VT
H|CS5084925000000|Windsor town, VT
H|CS5085075000000|Winhall town, VT
H|CS5085375000000|Wolcott town, VT
H|CS5085525000000|Woodbury town, VT
H|CS5085675000000|Woodford town, VT
H|CS5085975000000|Woodstock town, VT
H|CS5086125000000|Worcester town, VT
H|CT0901150000000|Ansonia city/town, CT
H|CT0919480000000|Derby city/town, CT
H|CT2302060000000|Auburn city, ME
H|CT2302100000000|Augusta city, ME
H|CT2303355000000|Bath city, ME
H|CT2303950000000|Belfast city, ME
H|CT2304860000000|Biddeford city, ME
H|CT2306925000000|Brewer city, ME
H|CT2309585000000|Calais city, ME
H|CT2310565000000|Caribou city, ME
H|CT2321730000000|Eastport city, ME
H|CT2323200000000|Ellsworth city, ME
H|CT2327085000000|Gardiner city, ME
H|CT2330550000000|Hallowell city, ME
H|CT2355225000000|Old Town city, ME
H|CT2360825000000|Presque Isle city, ME
H|CT2363590000000|Rockland city, ME
H|CT2364675000000|Saco city, ME
H|CT2365725000000|Sanford city, ME
H|CT2380740000000|Waterville city, ME
H|CT2382105000000|Westbrook city, ME
H|CT2501185000000|Amesbury city, MA
H|CT2519365000000|Easthampton city, MA
H|CT2525485000000|Gardner city, MA
H|CT2527060000000|Greenfield city, MA
H|CT2545245000000|Newburyport city, MA
H|CT2546225000000|North Adams city, MA
H|CT2552144000000|Palmer Town city, MA
H|CT2563345000000|Southbridge Town city, MA
H|CT2581005000000|Winthrop Town city, MA
H|CT3305140000000|Berlin city, NH
H|CT3312900000000|Claremont city, NH
H|CT3327380000000|Franklin city, NH
H|CT3339300000000|Keene city, NH
H|CT3340180000000|Laconia city, NH
H|CT3341300000000|Lebanon city, NH
H|CT3362900000000|Portsmouth city, NH
H|CT3369940000000|Somersworth city, NH
H|CT4414140000000|Central Falls city, RI
H|CT5003175000000|Barre city, VT
H|CT5024400000000|Essex Junction city, VT
H|CT5046000000000|Montpelier city, VT
H|CT5048850000000|Newport city, VT
H|CT5061225000000|Rutland city, VT
H|CT5061675000000|St. Albans city, VT
H|CT5066175000000|South Burlington city, VT
H|CT5074650000000|Vergennes city, VT
H|CT5085150000000|Winooski city, VT
I|PT0107000073000|Birmingham city, Jefferson County part, AL
I|PT0107000117000|Birmingham city, Shelby County part, AL
I|PT0120104083000|Decatur city, Limestone County part, AL
I|PT0120104103000|Decatur city, Morgan County part, AL
I|PT0121184045000|Dothan city, Dale County part, AL
I|PT0121184069000|Dothan city, Houston County part, AL
I|PT0124184031000|Enterprise city, Coffee County part, AL
I|PT0124184045000|Enterprise city, Dale County part, AL
I|PT0135896073000|Hoover city, Jefferson County part, AL
I|PT0135896117000|Hoover city, Shelby County part, AL
I|PT0137000083000|Huntsville city, Limestone County part, AL
I|PT0137000089000|Huntsville city, Madison County part, AL
I|PT0145784083000|Madison city, Limestone County part, AL
I|PT0145784089000|Madison city, Madison County part, AL
I|PT0159472081000|Phenix City city, Lee County part, AL
I|PT0159472113000|Phenix City city, Russell County part, AL
I|PT0162328001000|Prattville city, Autauga County part, AL
I|PT0162328051000|Prattville city, Elmore County part, AL
I|PT0176944073000|Trussville city, Jefferson County part, AL
I|PT0176944115000|Trussville city, St. Clair County part, AL
I|PT0178552073000|Vestavia Hills city, Jefferson County part, AL
I|PT0178552117000|Vestavia Hills city, Shelby County part, AL
I|PT0402830013000|Apache Junction city, Maricopa County part, AZ
I|PT0402830021000|Apache Junction city, Pinal County part, AZ
I|PT0458150013000|Queen Creek town, Maricopa County part, AZ
I|PT0458150021000|Queen Creek town, Pinal County part, AZ
I|PT0566080007000|Springdale city, Benton County part, AR
I|PT0566080143000|Springdale city, Washington County part, AR
I|PT0803455001000|Arvada city, Adams County part, CO
I|PT0803455059000|Arvada city, Jefferson County part, CO
I|PT0804000001000|Aurora city, Adams County part, CO
I|PT0804000005000|Aurora city, Arapahoe County part, CO
I|PT0804000035000|Aurora city, Douglas County part, CO
I|PT0808675001000|Brighton city, Adams County part, CO
I|PT0808675123000|Brighton city, Weld County part, CO
I|PT0824950013000|Erie town, Boulder County part, CO
I|PT0824950123000|Erie town, Weld County part, CO
I|PT0845255005000|Littleton city, Arapahoe County part, CO
I|PT0845255035000|Littleton city, Douglas County part, CO
I|PT0845255059000|Littleton city, Jefferson County part, CO
I|PT0845970013000|Longmont city, Boulder County part, CO
I|PT0845970123000|Longmont city, Weld County part, CO
I|PT0854330001000|Northglenn city, Adams County part, CO
I|PT0854330123000|Northglenn city, Weld County part, CO
I|PT0883835001000|Westminster city, Adams County part, CO
I|PT0883835059000|Westminster city, Jefferson County part, CO
I|PT0885485069000|Windsor town, Larimer County part, CO
I|PT0885485123000|Windsor town, Weld County part, CO
I|PT1304000089000|Atlanta city, DeKalb County part, GA
I|PT1304000121000|Atlanta city, Fulton County part, GA
I|PT1380508153000|Warner Robins city, Houston County part, GA
I|PT1380508225000|Warner Robins city, Peach County part, GA
I|PT1664090005000|Pocatello city, Bannock County part, ID
I|PT1664090077000|Pocatello city, Power County part, ID
I|PT1700685089000|Algonquin village, Kane County part, IL
I|PT1700685111000|Algonquin village, McHenry County part, IL
I|PT1703012043000|Aurora city, DuPage County part, IL
I|PT1703012089000|Aurora city, Kane County part, IL
I|PT1703012093000|Aurora city, Kendall County part, IL
I|PT1703012197000|Aurora city, Will County part, IL
I|PT1704013031000|Bartlett village, Cook County part, IL
I|PT1704013043000|Bartlett village, DuPage County part, IL
I|PT1707133043000|Bolingbrook village, DuPage County part, IL
I|PT1707133197000|Bolingbrook village, Will County part, IL
I|PT1709447031000|Buffalo Grove village, Cook County part, IL
I|PT1709447097000|Buffalo Grove village, Lake County part, IL
I|PT1715599119000|Collinsville city, Madison County part, IL
I|PT1715599163000|Collinsville city, St. Clair County part, IL
I|PT1723074031000|Elgin city, Cook County part, IL
I|PT1723074089000|Elgin city, Kane County part, IL
I|PT1732746031000|Hanover Park village, Cook County part, IL
I|PT1732746043000|Hanover Park village, DuPage County part, IL
I|PT1736750089000|Huntley village, Kane County part, IL
I|PT1736750111000|Huntley village, McHenry County part, IL
I|PT1738570093000|Joliet city, Kendall County part, IL
I|PT1738570197000|Joliet city, Will County part, IL
I|PT1751622043000|Naperville city, DuPage County part, IL
I|PT1751622197000|Naperville city, Will County part, IL
I|PT1757732031000|Park Forest village, Cook County part, IL
I|PT1757732197000|Park Forest village, Will County part, IL
I|PT1760287093000|Plainfield village, Kendall County part, IL
I|PT1760287197000|Plainfield village, Will County part, IL
I|PT1766703043000|St. Charles city, DuPage County part, IL
I|PT1766703089000|St. Charles city, Kane County part, IL
I|PT1775484031000|Tinley Park village, Cook County part, IL
I|PT1775484197000|Tinley Park village, Will County part, IL
I|PT1921000153000|Des Moines city, Polk County part, IA
I|PT1921000181000|Des Moines city, Warren County part, IA
I|PT1979950049000|Urbandale city, Dallas County part, IA
I|PT1979950153000|Urbandale city, Polk County part, IA
I|PT1983910049000|West Des Moines city, Dallas County part, IA
I|PT1983910153000|West Des Moines city, Polk County part, IA
I|PT1983910181000|West Des Moines city, Warren County part, IA
I|PT2044250149000|Manhattan city, Pottawatomie County part, KS
I|PT2044250161000|Manhattan city, Riley County part, KS
I|PT2270000015000|Shreveport city, Bossier Parish part, LA
I|PT2270000017000|Shreveport city, Caddo Parish part, LA
I|PT2624120037000|East Lansing city, Clinton County part, MI
I|PT2624120065000|East Lansing city, Ingham County part, MI
I|PT2638640005000|Holland city, Allegan County part, MI
I|PT2638640139000|Holland city, Ottawa County part, MI
I|PT2646000045000|Lansing city, Eaton County part, MI
I|PT2646000065000|Lansing city, Ingham County part, MI
I|PT2653780017000|Midland city, Bay County part, MI
I|PT2653780111000|Midland city, Midland County part, MI
I|PT2739878013000|Mankato city, Blue Earth County part, MN
I|PT2739878103000|Mankato city, Nicollet County part, MN
I|PT2756896009000|St. Cloud city, Benton County part, MN
I|PT2756896141000|St. Cloud city, Sherburne County part, MN
I|PT2756896145000|St. Cloud city, Stearns County part, MN
I|PT2769970123000|White Bear Lake city, Ramsey County part, MN
I|PT2769970163000|White Bear Lake city, Washington County part, MN
I|PT2831020035000|Hattiesburg city, Forrest County part, MS
I|PT2831020073000|Hattiesburg city, Lamar County part, MS
I|PT2836000049000|Jackson city, Hinds County part, MS
I|PT2836000089000|Jackson city, Madison County part, MS
I|PT2836000121000|Jackson city, Rankin County part, MS
I|PT2937000027000|Jefferson City city, Callaway County part, MO
I|PT2937000051000|Jefferson City city, Cole County part, MO
I|PT2937592097000|Joplin city, Jasper County part, MO
I|PT2937592145000|Joplin city, Newton County part, MO
I|PT2938000037000|Kansas City city, Cass County part, MO
I|PT2938000047000|Kansas City city, Clay County part, MO
I|PT2938000095000|Kansas City city, Jackson County part, MO
I|PT2938000165000|Kansas City city, Platte County part, MO
I|PT2941348037000|Lee's Summit city, Cass County part, MO
I|PT2941348095000|Lee's Summit city, Jackson County part, MO
I|PT3709060001000|Burlington city, Alamance County part, NC
I|PT3709060081000|Burlington city, Guilford County part, NC
I|PT3710740037000|Cary town, Chatham County part, NC
I|PT3710740183000|Cary town, Wake County part, NC
I|PT3711800063000|Chapel Hill town, Durham County part, NC
I|PT3711800135000|Chapel Hill town, Orange County part, NC
I|PT3719000063000|Durham city, Durham County part, NC
I|PT3719000135000|Durham city, Orange County part, NC
I|PT3719000183000|Durham city, Wake County part, NC
I|PT3731060023000|Hickory city, Burke County part, NC
I|PT3731060027000|Hickory city, Caldwell County part, NC
I|PT3731060035000|Hickory city, Catawba County part, NC
I|PT3731400057000|High Point city, Davidson County part, NC
I|PT3731400081000|High Point city, Guilford County part, NC
I|PT3731400151000|High Point city, Randolph County part, NC
I|PT3735200025000|Kannapolis city, Cabarrus County part, NC
I|PT3735200159000|Kannapolis city, Rowan County part, NC
I|PT3735600067000|Kernersville town, Forsyth County part, NC
I|PT3735600081000|Kernersville town, Guilford County part, NC
I|PT3744520063000|Morrisville town, Durham County part, NC
I|PT3744520183000|Morrisville town, Wake County part, NC
I|PT3755000063000|Raleigh city, Durham County part, NC
I|PT3755000183000|Raleigh city, Wake County part, NC
I|PT3757500065000|Rocky Mount city, Edgecombe County part, NC
I|PT3757500127000|Rocky Mount city, Nash County part, NC
I|PT3767420057000|Thomasville city, Davidson County part, NC
I|PT3767420151000|Thomasville city, Randolph County part, NC
I|PT3770540069000|Wake Forest town, Franklin County part, NC
I|PT3770540183000|Wake Forest town, Wake County part, NC
I|PT3918000041000|Columbus city, Delaware County part, OH
I|PT3918000045000|Columbus city, Fairfield County part, OH
I|PT3918000049000|Columbus city, Franklin County part, OH
I|PT3922694041000|Dublin city, Delaware County part, OH
I|PT3922694049000|Dublin city, Franklin County part, OH
I|PT3922694159000|Dublin city, Union County part, OH
I|PT3936610109000|Huber Heights city, Miami County part, OH
I|PT3936610113000|Huber Heights city, Montgomery County part, OH
I|PT3940040057000|Kettering city, Greene County part, OH
I|PT3940040113000|Kettering city, Montgomery County part, OH
I|PT3949840017000|Middletown city, Butler County part, OH
I|PT3949840165000|Middletown city, Warren County part, OH
I|PT3966390045000|Reynoldsburg city, Fairfield County part, OH
I|PT3966390049000|Reynoldsburg city, Franklin County part, OH
I|PT3966390089000|Reynoldsburg city, Licking County part, OH
I|PT3983342041000|Westerville city, Delaware County part, OH
I|PT3983342049000|Westerville city, Franklin County part, OH
I|PT4004450113000|Bartlesville city, Osage County part, OK
I|PT4004450147000|Bartlesville city, Washington County part, OK
I|PT4006400143000|Bixby city, Tulsa County part, OK
I|PT4006400145000|Bixby city, Wagoner County part, OK
I|PT4009050143000|Broken Arrow city, Tulsa County part, OK
I|PT4009050145000|Broken Arrow city, Wagoner County part, OK
I|PT4055000017000|Oklahoma City city, Canadian County part, OK
I|PT4055000027000|Oklahoma City city, Cleveland County part, OK
I|PT4055000109000|Oklahoma City city, Oklahoma County part, OK
I|PT4055000125000|Oklahoma City city, Pottawatomie County part, OK
I|PT4056650131000|Owasso city, Rogers County part, OK
I|PT4056650143000|Owasso city, Tulsa County part, OK
I|PT4075000113000|Tulsa city, Osage County part, OK
I|PT4075000143000|Tulsa city, Tulsa County part, OK
I|PT4075000145000|Tulsa city, Wagoner County part, OK
I|PT4101000003000|Albany city, Benton County part, OR
I|PT4101000043000|Albany city, Linn County part, OR
I|PT4140550005000|Lake Oswego city, Clackamas County part, OR
I|PT4140550051000|Lake Oswego city, Multnomah County part, OR
I|PT4159000005000|Portland city, Clackamas County part, OR
I|PT4159000051000|Portland city, Multnomah County part, OR
I|PT4159000067000|Portland city, Washington County part, OR
I|PT4164900047000|Salem city, Marion County part, OR
I|PT4164900053000|Salem city, Polk County part, OR
I|PT4174950005000|Tualatin city, Clackamas County part, OR
I|PT4174950067000|Tualatin city, Washington County part, OR
I|PT4182800005000|Wilsonville city, Clackamas County part, OR
I|PT4182800067000|Wilsonville city, Washington County part, OR
I|PT4206088077000|Bethlehem city, Lehigh County part, PA
I|PT4206088095000|Bethlehem city, Northampton County part, PA
I|PT4513330015000|Charleston city, Berkeley County part, SC
I|PT4513330019000|Charleston city, Charleston County part, SC
I|PT4516000063000|Columbia city, Lexington County part, SC
I|PT4516000079000|Columbia city, Richland County part, SC
I|PT4530985045000|Greer city, Greenville County part, SC
I|PT4530985083000|Greer city, Spartanburg County part, SC
I|PT4550695003000|North Augusta city, Aiken County part, SC
I|PT4550695037000|North Augusta city, Edgefield County part, SC
I|PT4550875019000|North Charleston city, Charleston County part, SC
I|PT4550875035000|North Charleston city, Dorchester County part, SC
I|PT4570270015000|Summerville town, Berkeley County part, SC
I|PT4570270019000|Summerville town, Charleston County part, SC
I|PT4570270035000|Summerville town, Dorchester County part, SC
I|PT4659020083000|Sioux Falls city, Lincoln County part, SD
I|PT4659020099000|Sioux Falls city, Minnehaha County part, SD
I|PT4738320019000|Johnson City city, Carter County part, TN
I|PT4738320163000|Johnson City city, Sullivan County part, TN
I|PT4738320179000|Johnson City city, Washington County part, TN
I|PT4739560073000|Kingsport city, Hawkins County part, TN
I|PT4739560163000|Kingsport city, Sullivan County part, TN
I|PT4755120001000|Oak Ridge city, Anderson County part, TN
I|PT4755120145000|Oak Ridge city, Roane County part, TN
I|PT4770580119000|Spring Hill city, Maury County part, TN
I|PT4770580187000|Spring Hill city, Williamson County part, TN
I|PT4801000253000|Abilene city, Jones County part, TX
I|PT4801000441000|Abilene city, Taylor County part, TX
I|PT4803000375000|Amarillo city, Potter County part, TX
I|PT4803000381000|Amarillo city, Randall County part, TX
I|PT4805000209000|Austin city, Hays County part, TX
I|PT4805000453000|Austin city, Travis County part, TX
I|PT4805000491000|Austin city, Williamson County part, TX
I|PT4806128071000|Baytown city, Chambers County part, TX
I|PT4806128201000|Baytown city, Harris County part, TX
I|PT4811428251000|Burleson city, Johnson County part, TX
I|PT4811428439000|Burleson city, Tarrant County part, TX
I|PT4813024085000|Carrollton city, Collin County part, TX
I|PT4813024113000|Carrollton city, Dallas County part, TX
I|PT4813024121000|Carrollton city, Denton County part, TX
I|PT4813492113000|Cedar Hill city, Dallas County part, TX
I|PT4813492139000|Cedar Hill city, Ellis County part, TX
I|PT4813552453000|Cedar Park city, Travis County part, TX
I|PT4813552491000|Cedar Park city, Williamson County part, TX
I|PT4813684085000|Celina city, Collin County part, TX
I|PT4813684121000|Celina city, Denton County part, TX
I|PT4816612113000|Coppell city, Dallas County part, TX
I|PT4816612121000|Coppell city, Denton County part, TX
I|PT4816624099000|Copperas Cove city, Coryell County part, TX
I|PT4816624281000|Copperas Cove city, Lampasas County part, TX
I|PT4819000085000|Dallas city, Collin County part, TX
I|PT4819000113000|Dallas city, Dallas County part, TX
I|PT4819000121000|Dallas city, Denton County part, TX
I|PT4819000397000|Dallas city, Rockwall County part, TX
I|PT4826232121000|Flower Mound town, Denton County part, TX
I|PT4826232439000|Flower Mound town, Tarrant County part, TX
I|PT4827000121000|Fort Worth city, Denton County part, TX
I|PT4827000367000|Fort Worth city, Parker County part, TX
I|PT4827000439000|Fort Worth city, Tarrant County part, TX
I|PT4827648167000|Friendswood city, Galveston County part, TX
I|PT4827648201000|Friendswood city, Harris County part, TX
I|PT4827684085000|Frisco city, Collin County part, TX
I|PT4827684121000|Frisco city, Denton County part, TX
I|PT4829000085000|Garland city, Collin County part, TX
I|PT4829000113000|Garland city, Dallas County part, TX
I|PT4830464113000|Grand Prairie city, Dallas County part, TX
I|PT4830464439000|Grand Prairie city, Tarrant County part, TX
I|PT4830644113000|Grapevine city, Dallas County part, TX
I|PT4830644439000|Grapevine city, Tarrant County part, TX
I|PT4835000157000|Houston city, Fort Bend County part, TX
I|PT4835000201000|Houston city, Harris County part, TX
I|PT4835000339000|Houston city, Montgomery County part, TX
I|PT4838476157000|Katy city, Fort Bend County part, TX
I|PT4838476201000|Katy city, Harris County part, TX
I|PT4838476473000|Katy city, Waller County part, TX
I|PT4841980167000|League City city, Galveston County part, TX
I|PT4841980201000|League City city, Harris County part, TX
I|PT4842016453000|Leander city, Travis County part, TX
I|PT4842016491000|Leander city, Williamson County part, TX
I|PT4842508113000|Lewisville city, Dallas County part, TX
I|PT4842508121000|Lewisville city, Denton County part, TX
I|PT4843888183000|Longview city, Gregg County part, TX
I|PT4843888203000|Longview city, Harrison County part, TX
I|PT4846452139000|Mansfield city, Ellis County part, TX
I|PT4846452251000|Mansfield city, Johnson County part, TX
I|PT4846452439000|Mansfield city, Tarrant County part, TX
I|PT4847892113000|Mesquite city, Dallas County part, TX
I|PT4847892257000|Mesquite city, Kaufman County part, TX
I|PT4848804157000|Missouri City city, Fort Bend County part, TX
I|PT4848804201000|Missouri City city, Harris County part, TX
I|PT4850820091000|New Braunfels city, Comal County part, TX
I|PT4850820187000|New Braunfels city, Guadalupe County part, TX
I|PT4853388135000|Odessa city, Ector County part, TX
I|PT4853388329000|Odessa city, Midland County part, TX
I|PT4856348039000|Pearland city, Brazoria County part, TX
I|PT4856348157000|Pearland city, Fort Bend County part, TX
I|PT4856348201000|Pearland city, Harris County part, TX
I|PT4857176453000|Pflugerville city, Travis County part, TX
I|PT4857176491000|Pflugerville city, Williamson County part, TX
I|PT4858016085000|Plano city, Collin County part, TX
I|PT4858016121000|Plano city, Denton County part, TX
I|PT4859696085000|Prosper town, Collin County part, TX
I|PT4859696121000|Prosper town, Denton County part, TX
I|PT4861796085000|Richardson city, Collin County part, TX
I|PT4861796113000|Richardson city, Dallas County part, TX
I|PT4863500453000|Round Rock city, Travis County part, TX
I|PT4863500491000|Round Rock city, Williamson County part, TX
I|PT4863572113000|Rowlett city, Dallas County part, TX
I|PT4863572397000|Rowlett city, Rockwall County part, TX
I|PT4863668085000|Royse City city, Collin County part, TX
I|PT4863668231000|Royse City city, Hunt County part, TX
I|PT4863668397000|Royse City city, Rockwall County part, TX
I|PT4864064085000|Sachse city, Collin County part, TX
I|PT4864064113000|Sachse city, Dallas County part, TX
I|PT4865000029000|San Antonio city, Bexar County part, TX
I|PT4865000325000|San Antonio city, Medina County part, TX
I|PT4866128029000|Schertz city, Bexar County part, TX
I|PT4866128091000|Schertz city, Comal County part, TX
I|PT4866128187000|Schertz city, Guadalupe County part, TX
I|PT4869032121000|Southlake city, Denton County part, TX
I|PT4869032439000|Southlake city, Tarrant County part, TX
I|PT4880356085000|Wylie city, Collin County part, TX
I|PT4880356113000|Wylie city, Dallas County part, TX
I|PT4880356397000|Wylie city, Rockwall County part, TX
I|PT4920120035000|Draper city, Salt Lake County part, UT
I|PT4920120049000|Draper city, Utah County part, UT
I|PT5303180033000|Auburn city, King County part, WA
I|PT5303180053000|Auburn city, Pierce County part, WA
I|PT5307380033000|Bothell city, King County part, WA
I|PT5307380061000|Bothell city, Snohomish County part, WA
I|PT5439460011000|Huntington city, Cabell County part, WV
I|PT5439460099000|Huntington city, Wayne County part, WV
I|PT5486452051000|Wheeling city, Marshall County part, WV
I|PT5486452069000|Wheeling city, Ohio County part, WV
I|PT5502375015000|Appleton city, Calumet County part, WI
I|PT5502375087000|Appleton city, Outagamie County part, WI
I|PT5502375139000|Appleton city, Winnebago County part, WI
I|PT5522300017000|Eau Claire city, Chippewa County part, WI
I|PT5522300035000|Eau Claire city, Eau Claire County part, WI
`;

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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

let LA_INDEX: LaRecord[] | null = null;
function getLaIndex(): LaRecord[] {
  if (LA_INDEX) return LA_INDEX;
  const records: LaRecord[] = [];
  for (const line of LA_AREA_TSV.split('\n')) {
    if (!line) continue;
    const [, code, name] = line.split('|');
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
