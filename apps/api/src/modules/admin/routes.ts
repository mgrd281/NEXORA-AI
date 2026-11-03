/**
 * Platform administration. Every endpoint here is `platform_admin` in the
 * contract table (enforced by defineRoute) and reads only through the narrow
 * SECURITY DEFINER functions of the schema, which return aggregates and
 * account metadata — never conversation, task or memory content.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { AdminOverview, AssistantStatus, Role } from '@jarvis/contracts';
import { pingDb } from '../../db/pool';
import { defineRoute } from '../../http/route';
import { AppError } from '../../lib/errors';
import type { AppDeps } from '../../services';
import { audit } from '../audit/audit';
import { isMicrosecondIso } from '../home/cursor';
import { workerHealth } from '../jobs/queue';

/** Row caps applied inside admin_list_users / admin_list_audit. */
const USERS_FN_CAP = 100;
const AUDIT_FN_CAP = 200;

interface OverviewJson {
  users_total: number;
  users_active_7d: number;
  tenants_total: number;
  tasks_by_status: Record<string, number>;
  queue_depth: number;
  cost_30d_micro: number;
  tool_reliability: {
    tool_id: string;
    executions: number;
    succeeded: number;
    failed: number;
    p50_ms: number | null;
    p95_ms: number | null;
  }[];
}

const num = (v: unknown) => Number(v ?? 0);
const optNum = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function hasMore(rows: number, limit: number, cap: number): boolean {
  // We ask for limit + 1 rows; when the function's cap swallows the extra row,
  // a full page means "maybe more" (the next page may then be empty).
  return rows > limit || (limit + 1 > cap && rows === cap);
}

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;

  defineRoute(app, deps, 'adminOverview', async ({ ctx, req }) => {
    const database = await pingDb(db);
    if (!database) throw new AppError('INTERNAL', 'The database is not reachable.');
    const [overview, worker, planner] = await Promise.all([
      sql<{ o: OverviewJson }>`select admin_overview() as o`.execute(db),
      workerHealth(db),
      deps.agent.status.get(ctx).then(
        (s): AssistantStatus['planner'] => s.planner,
        (err: unknown): AssistantStatus['planner'] => {
          req.log.error({ err }, 'assistant status unavailable');
          return { mode: 'offline', provider: null, reason: 'STATUS_UNAVAILABLE' };
        },
      ),
    ]);
    const o = overview.rows[0]!.o;
    const result: AdminOverview = {
      generatedAt: new Date().toISOString(),
      health: {
        database,
        worker: {
          healthy: worker.healthy,
          lastHeartbeatAt: worker.lastHeartbeatAt ? worker.lastHeartbeatAt.toISOString() : null,
        },
        planner,
        queueDepth: num(o.queue_depth),
      },
      users: { total: num(o.users_total), active7d: num(o.users_active_7d) },
      tenants: { total: num(o.tenants_total) },
      tasksByStatus: Object.fromEntries(
        Object.entries(o.tasks_by_status ?? {}).map(([k, v]) => [k, num(v)]),
      ),
      toolReliability: (o.tool_reliability ?? []).map((r) => ({
        toolId: r.tool_id,
        executions: num(r.executions),
        succeeded: num(r.succeeded),
        failed: num(r.failed),
        p50Ms: optNum(r.p50_ms),
        p95Ms: optNum(r.p95_ms),
      })),
      cost30dMicroUsd: num(o.cost_30d_micro),
    };
    return result;
  });

  defineRoute(app, deps, 'adminUsers', async ({ ctx, query }) => {
    // Cursor: created_at (UTC ISO, microseconds) of the last user on the previous page.
    if (query.cursor !== undefined && !isMicrosecondIso(query.cursor))
      throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
    const before = query.cursor ?? null;
    const res = await sql<{
      id: string;
      email: string;
      tenant_name: string;
      roles: string[];
      status: 'active' | 'disabled';
      created_at: Date;
      last_active_at: Date | null;
      task_count: number;
      cursor_ts: string;
    }>`
      select u.*, to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts
        from admin_list_users(${query.limit + 1}, ${before}::timestamptz) u`.execute(db);
    const more = hasMore(res.rows.length, query.limit, USERS_FN_CAP);
    const rows = res.rows.slice(0, query.limit);
    await audit(db, {
      tenantId: ctx.tenantId,
      actorType: 'admin',
      actorId: ctx.userId,
      action: 'admin.users_viewed',
      metadata: { count: rows.length },
    });
    return {
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        tenantName: u.tenant_name,
        roles: u.roles as Role[],
        status: u.status,
        createdAt: u.created_at.toISOString(),
        lastActiveAt: u.last_active_at ? u.last_active_at.toISOString() : null,
        taskCount: num(u.task_count),
      })),
      nextCursor: more && rows.length > 0 ? rows[rows.length - 1]!.cursor_ts : null,
    };
  });

  defineRoute(app, deps, 'adminAudit', async ({ ctx, query }) => {
    // Cursor: id of the last audit event on the previous page.
    if (query.cursor !== undefined && !/^[1-9]\d{0,15}$/.test(query.cursor))
      throw new AppError('VALIDATION_FAILED', 'Invalid cursor');
    const beforeId = query.cursor ? Number(query.cursor) : null;
    const res = await sql<{
      id: number;
      created_at: Date;
      tenant_id: string | null;
      actor_type: 'user' | 'system' | 'agent' | 'admin';
      actor_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
    }>`select * from admin_list_audit(${query.limit + 1}, ${beforeId}::bigint)`.execute(db);
    const more = hasMore(res.rows.length, query.limit, AUDIT_FN_CAP);
    const rows = res.rows.slice(0, query.limit);
    await audit(db, {
      tenantId: ctx.tenantId,
      actorType: 'admin',
      actorId: ctx.userId,
      action: 'admin.audit_viewed',
      metadata: { count: rows.length },
    });
    return {
      items: rows.map((a) => ({
        id: String(a.id),
        at: a.created_at.toISOString(),
        tenantId: a.tenant_id,
        actorType: a.actor_type,
        actorId: a.actor_id,
        action: a.action,
        targetType: a.target_type,
        targetId: a.target_id,
      })),
      nextCursor: more && rows.length > 0 ? String(rows[rows.length - 1]!.id) : null,
    };
  });
}
