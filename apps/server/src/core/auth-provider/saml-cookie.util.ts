export function samlBindingCookie(providerId: string) {
  return {
    httpOnly: true,
    sameSite: 'none' as const,
    path: `/api/sso/${providerId}/callback`,
    maxAge: 600,
    secure: true,
  };
}
