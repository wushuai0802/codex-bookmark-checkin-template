export async function closeSharedContexts(sharedContexts, activeContexts) {
  const contexts = [...new Set(sharedContexts.values())];
  sharedContexts.clear();
  for (const context of contexts) activeContexts.delete(context);
  await Promise.all(contexts.map((context) => context.close().catch(() => {})));
  return contexts.length;
}
