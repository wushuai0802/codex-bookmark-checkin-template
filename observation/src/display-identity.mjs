// Display metadata is explicitly allowlisted and never used for execution identity.
export function shortLabel(value, limit = 80) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!text || text.length > limit || /[\x00-\x1f<>]|(?:password|cookie|token|secret|authorization)\s*[:=]|[A-Za-z]:[\\/]/i.test(text)) return null;
  return text;
}

export function displayIdentity(input = {}) {
  const userId = shortLabel(input.userId, 40);
  return {
    userId: userId && /^[\w.-]+$/.test(userId) ? userId : null,
    username: shortLabel(input.username),
    label: shortLabel(input.label),
    provider: shortLabel(input.provider, 40),
    source: ['result', 'harvest', 'configuration', 'user-self', 'browser-cache'].includes(input.source) ? input.source : null,
    idKind: input.idKind === 'linuxdo' ? 'linuxdo' : 'site',
    observedAt: typeof input.observedAt === 'string' && Number.isFinite(Date.parse(input.observedAt)) ? new Date(input.observedAt).toISOString() : null
  };
}
