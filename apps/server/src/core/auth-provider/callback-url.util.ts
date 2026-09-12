import { BadRequestException } from '@nestjs/common';

export function buildCallbackUrl(
  appUrl: string,
  isCloud: boolean,
  subdomainHost: string | undefined,
  workspaceHostname: string,
  providerId: string,
): string {
  const hostname = isCloud ? validateHostname(workspaceHostname) : undefined;
  const url = new URL(appUrl);
  if (
    isCloud &&
    url.hostname !== `${hostname}.${subdomainHost}`.toLowerCase()
  ) {
    throw new BadRequestException('Workspace callback host is invalid.');
  }
  url.pathname = `/api/sso/${encodeURIComponent(providerId)}/callback`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function buildWorkspaceUrl(
  appUrl: string,
  isCloud: boolean,
  subdomainHost: string | undefined,
  workspaceHostname: string,
): string {
  if (isCloud) {
    buildCallbackUrl(appUrl, true, subdomainHost, workspaceHostname, 'check');
  }
  return new URL(appUrl).origin;
}

export function buildSamlUrls(
  appUrl: string,
  isCloud: boolean,
  subdomainHost: string | undefined,
  workspaceHostname: string,
  providerId: string,
): { entityId: string; callbackUrl: string } {
  const origin = buildWorkspaceUrl(
    appUrl,
    isCloud,
    subdomainHost,
    workspaceHostname,
  );
  const id = encodeURIComponent(providerId);
  return {
    entityId: `${origin}/api/sso/saml/${id}/login`,
    callbackUrl: `${origin}/api/sso/saml/${id}/callback`,
  };
}

function validateHostname(hostname: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new BadRequestException('Workspace hostname is invalid.');
  }
  return hostname;
}
