/**
 * Shape and lookup for the IPC channel list in ipcChannelAllowlist.json, which
 * scripts/ipc-channel-allowlist.mjs derives from the source (NIB.85 stage d3).
 *
 * LOG-ONLY: this answers "is this channel one the app's renderer code is known
 * to use?" so main can log the ones it is not. Nothing is blocked on it.
 */

export interface IpcChannelAllowlist {
  /** Literal channels the renderer side sends to main. */
  channels: string[];
  /** Channels built at run time, matched by prefix (`git:` for `git:${action}`). */
  dynamicPrefixes: string[];
  /** Channels main sends to the renderer (informational). */
  listen: string[];
}

const lookupCache = new WeakMap<IpcChannelAllowlist, Set<string>>();

export function isAllowlistedChannel(channel: string, list: IpcChannelAllowlist): boolean {
  if (!channel) return false;
  let set = lookupCache.get(list);
  if (!set) {
    set = new Set(list.channels);
    lookupCache.set(list, set);
  }
  if (set.has(channel)) return true;
  return list.dynamicPrefixes.some((prefix) => channel.startsWith(prefix));
}
