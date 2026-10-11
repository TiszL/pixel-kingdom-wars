/** Version-gated ground downgrade for old native renderers (docs/REALM-KIT-PLAN.md
 * E-12). A base or raid whose visual context names groundRevision 5 (the realm
 * kit) is presented to an Android renderer below NATIVE_REALM_KIT_RENDERER_CONTRACT
 * as the same realm at revision 4 — the published layered painting that APK
 * already carries — instead of letting the client strip the unknown revision and
 * paint the artVersion-2 ground. Presentation only: the frozen raid row, the
 * replay archive, the deed image and the simulation input are untouched, and the
 * web client (which reloads to the latest bundle on deploy) is never rewritten.
 *
 * Wired once as a preSerialization hook so every route that carries a
 * `visualContext` — GET /base, raid creation, resume, live, replay, scouting,
 * campaign preview and both native presentation transports — obeys one rule. */
import type { FastifyInstance } from 'fastify';
import { isRealmKitBaseVisualContext, resolveBaseVisualContext, type BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { NATIVE_CLIENT_ANDROID, NATIVE_CLIENT_HEADER, NATIVE_REALM_KIT_RENDERER_CONTRACT, NATIVE_RENDERER_CONTRACT_HEADER } from './contracts';

type Headers = Record<string, unknown>;
const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
};

/** The renderer contract a native request declares: `null` for every non-native
 * client, `0` for a native client that predates the header (every APK through
 * contract 14), else the declared non-negative integer. Malformed values count as
 * predating the header — a stale renderer must never be promoted by a typo. */
export function nativeRendererContract(headers: Headers): number | null {
  if (header(headers, NATIVE_CLIENT_HEADER) !== NATIVE_CLIENT_ANDROID) return null;
  const raw = header(headers, NATIVE_RENDERER_CONTRACT_HEADER);
  if (raw === undefined || !/^[0-9]{1,6}$/.test(raw)) return 0;
  return Number(raw);
}

/** True when this request's renderer cannot read revision-5 ground. */
export function nativeClientNeedsRealmKitDowngrade(headers: Headers): boolean {
  const contract = nativeRendererContract(headers);
  return contract !== null && contract < NATIVE_REALM_KIT_RENDERER_CONTRACT;
}

/** The same realm at revision 4. Every realm on CURRENT_LAYERED_REVISION_BY_REALM
 * has a pinned BASE_LAYERED_GROUND_V4 descriptor (realm-kit-visual.test.ts pins
 * that), so the rewrite always names published scenery. Any other context —
 * historical, painted, revision 3/4 — is returned as the same reference. */
export function presentVisualContextForClient(context: unknown, headers: Headers): unknown {
  if (!nativeClientNeedsRealmKitDowngrade(headers)) return context;
  const resolved = resolveBaseVisualContext(context);
  if (!isRealmKitBaseVisualContext(resolved)) return context;
  const downgraded: BaseVisualContext = { version: 1, realmId: resolved.realmId, artVersion: 2, groundRevision: 4 };
  return downgraded;
}

/** Bounded copy-on-write walk: `visualContext` keys at the payload root, inside a
 * nested DTO (`raid`, `state`) or a list of DTOs (`raids[]`) are rewritten; the
 * payload is returned by reference when nothing changes. Only plain objects and
 * arrays are entered — Dates, buffers and typed arrays are leaves. */
const MAX_DEPTH = 4;
function rewrite(value: unknown, headers: Headers, depth: number): unknown {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || value instanceof Date || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = rewrite(value[i], headers, depth + 1);
      if (next !== value[i]) { out ??= [...value]; out[i] = next; }
    }
    return out ?? value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const key in record) {
    const item = record[key];
    const next = key === 'visualContext' ? presentVisualContextForClient(item, headers) : rewrite(item, headers, depth + 1);
    if (next !== item) { out ??= { ...record }; out[key] = next; }
  }
  return out ?? value;
}
export function presentPayloadForClient(payload: unknown, headers: Headers): unknown {
  return nativeClientNeedsRealmKitDowngrade(headers) ? rewrite(payload, headers, 0) : payload;
}

/** Registered by registerNativeRoutes, which both the ordinary API and the native
 * companion call, so the rule cannot exist on one surface and not the other. */
export function registerNativeClientPresentation(app: FastifyInstance): void {
  app.addHook('preSerialization', async (req, _reply, payload) => presentPayloadForClient(payload, req.headers));
}
