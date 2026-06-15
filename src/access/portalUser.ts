import type { PortalUser } from '../contracts/portal-access.js';
import type { PortalAdapter } from '../portal/adapter.js';

/** Exchange a portal OAuth code and return the authenticated portal user (no ORBIT mint). */
export async function resolvePortalUser(
  portal: PortalAdapter,
  portalAuthCode: string,
  redirectUri?: string,
): Promise<PortalUser> {
  const portalToken = await portal.exchangeAuthCode(portalAuthCode, redirectUri);
  return portal.getMe(portalToken);
}
