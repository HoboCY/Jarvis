export async function ensureConversation<T>(
  current: T | undefined,
  create: () => Promise<T | undefined>
): Promise<T | undefined> {
  return current ?? create();
}
