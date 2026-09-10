/**
 * What happens after a draft is published.
 *
 * A registry rather than a direct call: rank 6 must not know about rank 24. This
 * module imports nothing from the features, so there is no import cycle - the
 * feature registers itself when its module loads.
 */
import type { Env } from "../env";
import type { Draft } from "./draft";

export type PublishHook = (env: Env, draft: Draft) => Promise<void>;

const handlers = new Map<string, PublishHook>();

export function registerPublishHook(name: string, handler: PublishHook): void {
  handlers.set(name, handler);
}

/** Dispatched on `meta.hook`. A failure here must not unpublish anything. */
export async function dispatchPublished(env: Env, draft: Draft): Promise<void> {
  const name = draft.meta?.hook;
  if (!name) return;

  const handler = handlers.get(name);
  if (!handler) {
    console.error("no publish hook registered for", name, draft.id);
    return;
  }
  try {
    await handler(env, draft);
  } catch (err) {
    console.error("publish hook failed", name, draft.id, err);
  }
}
