import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  PRISM_TOOLS,
  type EffectiveToolAccess,
  type PortalUser,
  type PrismTool,
  type ToolGrants,
} from '../contracts/portal-access.js';
import { getDb } from '../db/client.js';
import { toolGrant } from '../db/schema.js';

const ADMIN_PORTAL_ROLES = new Set(['superadmin', 'admin', 'prism-admin']);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRole(role: string): string {
  return role.trim();
}

function isPrismTool(value: string): value is PrismTool {
  return (PRISM_TOOLS as readonly string[]).includes(value);
}

function legacyAdminEmails(): Set<string> {
  const raw = process.env.PORTAL_ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function collectRoleRefs(portalUser: PortalUser, extraRoleRefs: string[] = []): string[] {
  const roles = new Set<string>();
  if (portalUser.role) roles.add(normalizeRole(portalUser.role));
  if (portalUser.customRoleId) roles.add(normalizeRole(portalUser.customRoleId));
  for (const ref of extraRoleRefs) {
    if (ref?.trim()) roles.add(normalizeRole(ref));
  }
  return [...roles];
}

/** PRISM admin cookie (username/password login) — always full tool access. */
export function fullLocalAdminToolAccess(email: string): EffectiveToolAccess {
  return {
    email: normalizeEmail(email),
    roles: ['local-admin'],
    isPrismAdmin: true,
    tools: [...PRISM_TOOLS],
  };
}

export async function loadToolGrants(): Promise<ToolGrants> {
  const db = getDb();
  const rows = await db.select().from(toolGrant);
  const grants: ToolGrants = { roles: {}, users: {} };

  for (const row of rows) {
    if (!isPrismTool(row.tool)) continue;
    const target =
      row.principalType === 'user'
        ? (grants.users ?? (grants.users = {}))
        : grants.roles;
    const key =
      row.principalType === 'user'
        ? normalizeEmail(row.principalRef)
        : normalizeRole(row.principalRef);
    const list = target[key] ?? (target[key] = []);
    if (!list.includes(row.tool)) list.push(row.tool);
  }

  return grants;
}

export async function saveToolGrants(grants: ToolGrants): Promise<void> {
  const db = getDb();
  await db.delete(toolGrant);

  const values: Array<typeof toolGrant.$inferInsert> = [];
  for (const [role, tools] of Object.entries(grants.roles ?? {})) {
    const roleRef = normalizeRole(role);
    if (!roleRef) continue;
    for (const tool of tools) {
      if (!isPrismTool(tool)) continue;
      values.push({
        id: randomUUID(),
        principalType: 'role',
        principalRef: roleRef,
        tool,
      });
    }
  }
  for (const [email, tools] of Object.entries(grants.users ?? {})) {
    const emailRef = normalizeEmail(email);
    if (!emailRef) continue;
    for (const tool of tools) {
      if (!isPrismTool(tool)) continue;
      values.push({
        id: randomUUID(),
        principalType: 'user',
        principalRef: emailRef,
        tool,
      });
    }
  }

  if (values.length) {
    await db.insert(toolGrant).values(values);
  }
}

export async function resolveToolAccess(input: {
  email: string;
  portalUser?: PortalUser | null;
  roleRefs?: string[];
}): Promise<EffectiveToolAccess> {
  const email = normalizeEmail(input.email);
  const roles = collectRoleRefs(input.portalUser ?? { userId: '', email }, input.roleRefs ?? []);

  const isPrismAdmin =
    legacyAdminEmails().has(email) ||
    roles.some((r) => ADMIN_PORTAL_ROLES.has(r.toLowerCase()));

  if (isPrismAdmin) {
    return {
      email,
      roles,
      isPrismAdmin: true,
      tools: [...PRISM_TOOLS],
    };
  }

  const db = getDb();
  const roleKeys = roles.map((r) => normalizeRole(r)).filter(Boolean);

  if (roleKeys.length === 0) {
    const userRows = await db
      .select({ tool: toolGrant.tool })
      .from(toolGrant)
      .where(and(eq(toolGrant.principalType, 'user'), eq(toolGrant.principalRef, email)));
    const tools = new Set<PrismTool>();
    for (const row of userRows) {
      if (isPrismTool(row.tool)) tools.add(row.tool);
    }
    return { email, roles, isPrismAdmin: false, tools: [...tools] };
  }

  const rows = await db
    .select({ tool: toolGrant.tool })
    .from(toolGrant)
    .where(
      or(
        and(eq(toolGrant.principalType, 'user'), eq(toolGrant.principalRef, email)),
        and(eq(toolGrant.principalType, 'role'), inArray(toolGrant.principalRef, roleKeys)),
      ),
    );

  const tools = new Set<PrismTool>();
  for (const row of rows) {
    if (isPrismTool(row.tool)) tools.add(row.tool);
  }

  return {
    email,
    roles,
    isPrismAdmin: false,
    tools: [...tools],
  };
}

export async function authorizeTool(email: string, tool: PrismTool): Promise<boolean> {
  if (!isPrismTool(tool)) return false;
  const access = await resolveToolAccess({ email });
  return access.tools.includes(tool);
}

export async function resolveEmailFromAdminUsername(username: string): Promise<string | null> {
  const trimmed = username.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return normalizeEmail(trimmed);
  return normalizeEmail(`${trimmed}@rebus.industries`);
}
