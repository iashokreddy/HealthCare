import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import { STAFF_ROLES, type Role } from '../db/schema.js';
import type { AccessClaims } from '../services/tokens.js';
import { forbidden, HttpError, unauthorized } from './http.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AccessClaims | null;
    /** Set when a clinician invoked emergency "break-glass" access for this request. */
    breakGlassReason: string | null;
  }
}

export interface GuardOptions {
  roles?: readonly Role[];
  /** Allows staff who haven't completed MFA (only for MFA enrollment & profile endpoints). */
  allowWithoutMfa?: boolean;
}

/**
 * Builds a preHandler that authenticates the bearer token and enforces role + MFA policy.
 * Deny-by-default: every route that isn't explicitly public must use a guard.
 */
export function guard(ctx: AppContext, opts: GuardOptions = {}): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let claims: AccessClaims;
    try {
      claims = await ctx.tokens.verifyAccess(header.slice(7));
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    req.user = claims;

    if (ctx.cfg.REQUIRE_STAFF_MFA && STAFF_ROLES.includes(claims.role) && !claims.amr.includes('otp') && !opts.allowWithoutMfa) {
      throw new HttpError(403, 'MFA_REQUIRED', 'Multi-factor authentication is required for staff accounts');
    }

    if (opts.roles && !opts.roles.includes(claims.role)) {
      await ctx.audit.record({
        actorId: claims.sub,
        actorRole: claims.role,
        action: 'authz.denied',
        resourceType: 'route',
        resourceId: `${req.method} ${req.routeOptions.url}`,
        outcome: 'denied',
        ip: req.ip,
      });
      throw forbidden();
    }
  };
}

export function currentUser(req: FastifyRequest): AccessClaims {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * Attribute-based access check for facility-scoped data.
 *  - admin: all facilities
 *  - staff: own facility; clinicians may invoke audited break-glass access elsewhere
 *  - patients: never facility-wide
 */
export function assertFacilityAccess(req: FastifyRequest, facilityId: string) {
  const u = currentUser(req);
  if (u.role === 'admin') return;
  if (u.role !== 'patient' && u.fid === facilityId) return;
  if (u.role === 'clinician') {
    const reason = req.headers['x-break-glass-reason'];
    if (typeof reason === 'string' && reason.trim().length >= 10) {
      req.breakGlassReason = reason.trim().slice(0, 500);
      return;
    }
  }
  throw forbidden();
}

/** Patients may read only their own chart; biomedical techs never see PHI (minimum necessary). */
export function assertPatientAccess(req: FastifyRequest, patient: { id: string; facility_id: string }) {
  const u = currentUser(req);
  if (u.role === 'patient') {
    if (u.pid !== patient.id) throw forbidden();
    return;
  }
  if (u.role === 'biomed_tech') throw forbidden();
  assertFacilityAccess(req, patient.facility_id);
}
