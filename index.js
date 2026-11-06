/**
 * dsh-prompt-tune — Host half.
 *
 * Serves `POST /prompt-tune/optimize`: takes the composer draft the user
 * typed, rewrites it into an execution-ready prompt with the live model route,
 * and returns the rewritten text. The Client half owns the pill button and
 * writes the result back into the composer draft.
 *
 * Route resolution order:
 *   1. explicit `provider`/`model` from plugin config
 *   2. the request-header route of the Agent that owns the posted sessionId
 *   3. `agentDefaultModel.currentSelection()`
 *   4. the first registered provider's first advertised model
 *
 * The same rewrite is exposed as the `optimize_prompt` agent tool, so the
 * operation has exactly one implementation behind two callers.
 */

const NAME = 'dsh-prompt-tune';
const ROUTE = '/prompt-tune/optimize';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_INPUT_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 4096;

const SYSTEM_PROMPT = [
  'You are a prompt engineer embedded in a coding agent harness.',
  'Your only job: turn a rough, vague, or sloppy user prompt into one precise prompt the agent can execute in a single pass.',
  '',
  'Rules:',
  '- Output ONLY the rewritten prompt. No preamble, no explanation, no meta commentary, no "here is the improved prompt".',
  '- Write in the same language the original prompt was written in. Mixed-language input keeps its dominant language.',
  '- Preserve every concrete fact from the original: names, paths, identifiers, versions, commands, numbers, file names, error strings, quoted text, and stated constraints.',
  '- Never invent facts the original did not contain. Where a required detail is genuinely missing, write an explicit `[待补充: ...]` / `[missing: ...]` slot instead of guessing a plausible value.',
  '- Make the goal explicit: what the end state is, what "done" means, and what the deliverable is (answer, code change, file, command output).',
  '- Add the operative specifics the original implied but left implicit: target scope (which files, modules, endpoints, environments), ordered steps, acceptance checks, and what to leave untouched.',
  '- Keep it executable: numbered steps or ordered requirements, each one actionable. Prefer imperative voice.',
  '- Cut rhetorical filler, hedging, gratitude, and restatements of the question.',
  '- Stay inside the original intent and scale. Do not expand a small task into a project plan, and do not add requirements the user never asked for.',
  '- If the original is already precise, tighten it rather than rewrite it: keep its structure, fix ambiguity and ordering.',
  '- Do not wrap the output in code fences.',
  '- If the original is empty or has no actionable content, return the original text unchanged.',
].join('\n');

/* ------------------------------------------------------------------ config */

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function resolveConfig(config) {
  const value = config && typeof config === 'object' ? config : {};
  return {
    timeoutMs: positiveInt(value.timeoutMs, DEFAULT_TIMEOUT_MS, 5000, 300000),
    maxInputChars: positiveInt(value.maxInputChars, DEFAULT_MAX_INPUT_CHARS, 200, 200000),
    provider: typeof value.provider === 'string' && value.provider ? value.provider : undefined,
    model: typeof value.model === 'string' && value.model ? value.model : undefined,
  };
}

/* ------------------------------------------------------------------- route */

function routeFromSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  try {
    const agents = ctx.get('agents');
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : undefined;
    const config = header && header.config;
    if (config && typeof config.provider === 'string' && typeof config.model === 'string'
      && config.provider && config.model) {
      return { provider: config.provider, model: config.model };
    }
  } catch { /* session may not be retained yet */ }
  return undefined;
}

function routeFromDefault(ctx) {
  try {
    const service = ctx.get('agentDefaultModel');
    const selection = service && typeof service.currentSelection === 'function'
      ? service.currentSelection()
      : undefined;
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model };
    }
  } catch { /* service absent in some compositions */ }
  return undefined;
}

async function routeFromRegistry(ctx) {
  try {
    const providers = ctx.llm.listProviders();
    for (const info of providers) {
      const models = await ctx.llm.listModels(info.id);
      if (models.length > 0) return { provider: info.id, model: models[0].id };
    }
  } catch { /* no adapter can answer */ }
  return undefined;
}

/* ------------------------------------------------------------------ rewrite */

/** Strip a whole-string triple-backtick wrapper the model may still add. */
function unwrapFence(text) {
  const trimmed = text.trim();
  const match = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * Run one optimization call.
 * @param ctx - Host context carrying `llm`.
 * @param route - `{ provider, model }`.
 * @param input - the raw draft.
 * @param signal - deadline signal.
 * @returns the rewritten prompt text.
 */
async function runOptimization(ctx, route, input, signal) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: input }] }];
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    system: SYSTEM_PROMPT,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
  };

  let text = '';
  let failure;
  for await (const chunk of ctx.llm.stream(options)) {
    if (signal.aborted) break;
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish' && chunk.reason
      && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      failure = chunk.reason.failure || { message: 'model call failed' };
    }
  }
  if (failure) throw new Error(failure.message || 'model call failed');
  const out = unwrapFence(text);
  if (out.length === 0) throw new Error('模型没有返回任何内容');
  return out;
}

/**
 * Resolve a route and run the rewrite under one deadline.
 * @param ctx - Host context.
 * @param config - resolved plugin config.
 * @param input - the raw draft.
 * @param sessionId - optional Session whose live route should win.
 * @returns `{ text, route }` or throws with a user-facing reason.
 */
async function optimize(ctx, config, input, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const route = (config.provider && config.model
      ? { provider: config.provider, model: config.model }
      : undefined)
      || routeFromSession(ctx, sessionId)
      || routeFromDefault(ctx)
      || await routeFromRegistry(ctx);
    if (!route) throw new Error('没有可用的模型路由');
    const text = await runOptimization(ctx, route, input, controller.signal);
    return { text, route };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`优化超时（${config.timeoutMs} ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- HTTP */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 512 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) { try { res.end(); } catch { } return; }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Loopback callers pass; anyone else must match Host so the page stays same-origin. */
function originAllowed(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

/* ------------------------------------------------------------------- apply */

/**
 * Register the optimize route, and the matching agent tool when the Tools
 * registry is present in this composition.
 * @param ctx - Host plugin context.
 * @param config - raw Loader config.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const state = { tool: 'absent', error: '' };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return; }
      if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return; }

      let body;
      try {
        const raw = await readBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
        return;
      }

      const text = typeof body.text === 'string' ? body.text : '';
      if (text.trim().length === 0) { sendJson(res, 400, { ok: false, error: 'empty prompt' }); return; }
      if (text.length > resolved.maxInputChars) {
        sendJson(res, 413, { ok: false, error: `prompt too long (${text.length} > ${resolved.maxInputChars})` });
        return;
      }

      try {
        const result = await optimize(ctx, resolved, text, body.sessionId);
        sendJson(res, 200, { ok: true, text: result.text, route: result.route });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
    },
  }), `${NAME}: optimize route`);

  /* Diagnostics: whether the agent-side tool actually registered, and why not. */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/prompt-tune/status',
    handler: (req, res) => {
      sendJson(res, 200, { ok: true, tool: state.tool, error: state.error, config: resolved });
    },
  }), `${NAME}: status route`);

  registerTool(ctx, resolved, state);
}

/**
 * Expose the same operation to the agent. A missing Tools registry or an
 * unresolvable `dsh-tools` import leaves the HTTP route working alone.
 * @param ctx - Host plugin context.
 * @param resolved - resolved plugin config.
 */
function registerTool(ctx, resolved, state) {
  let tools;
  try { tools = ctx.tools; } catch { tools = undefined; }
  if (!tools || typeof tools.register !== 'function') {
    state.tool = 'unavailable';
    console.warn(`${NAME}: tools service unavailable; only the HTTP route is active`);
    return;
  }

  const definition = {
    name: 'optimize_prompt',
    description: 'Rewrite a rough prompt into one precise, execution-ready prompt using the live model route. Returns the rewritten text only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'The raw prompt text to rewrite.' },
        sessionId: { type: 'string', description: 'Session whose live model route should be used; omit to use the default route.' },
      },
    },
    execute: async (args, exec) => {
      const input = typeof args.text === 'string' ? args.text : '';
      if (input.trim().length === 0) throw new Error('optimize_prompt requires non-empty text');
      if (input.length > resolved.maxInputChars) throw new Error(`text too long (${input.length} > ${resolved.maxInputChars})`);
      const sessionId = typeof args.sessionId === 'string'
        ? args.sessionId
        : (exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined);
      const result = await optimize(ctx, resolved, input, sessionId);
      return { text: result.text, provider: result.route.provider, model: result.route.model };
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'provider', 'model'],
        properties: {
          text: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text,
      }],
    },
  };

  try {
    const dispose = tools.register(definition);
    if (typeof dispose === 'function') ctx.effect(() => dispose, `${NAME}: optimize_prompt tool`);
    state.tool = 'registered';
  } catch (error) {
    state.tool = 'failed';
    state.error = String((error && error.message) || error);
    console.warn(`${NAME}: optimize_prompt tool not registered:`, state.error);
  }
}

export const name = NAME;
export const inject = ['llm', 'webServer', 'tools'];
