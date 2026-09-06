export function appendReturnTo(href: string, returnTo: string) {
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}from=${encodeURIComponent(returnTo)}`;
}

export function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}
