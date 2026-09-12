export function samlBindingCookie(providerId: string) {
  return {
    httpOnly: true,
    sameSite: 'none' as const,
    path: samlBindingPath(providerId),
    maxAge: 600,
    secure: true,
  };
}

export function samlBindingPath(providerId: string): string {
  return `/api/sso/saml/${encodeURIComponent(providerId)}/callback`;
}
