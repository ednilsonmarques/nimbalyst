import { isAllowlistedChannel, type IpcChannelAllowlist } from '../../shared/ipcChannelAllowlist';

export interface ChannelAllowlistObserverOptions {
  log: (message: string) => void;
  /** Most distinct unlisted channels to log; beyond it one notice is written. */
  cap?: number;
}

export type ChannelAllowlistObserver = ((channel: string) => void) & {
  /** Number of channel names the observer is holding (tests). Bounded by `cap`. */
  trackedChannels: () => number;
};

/**
 * Observer for ipcRegistry (NIB.85 stage d3, LOG-ONLY, decision U6). Returns
 * nothing and never throws: it can only write a log line, once per unlisted
 * channel and at most `cap` distinct unlisted channels, so it cannot change
 * behavior or flood the log. Listed channels are looked up, never stored: a
 * channel under a dynamic prefix carries a unique id, so remembering them
 * would grow without bound. Only the (capped) logged unlisted names are kept.
 */
export function createChannelAllowlistObserver(
  list: IpcChannelAllowlist,
  options: ChannelAllowlistObserverOptions,
): ChannelAllowlistObserver {
  const cap = options.cap ?? 100;
  const loggedUnlisted = new Set<string>();
  let capReported = false;

  const write = (message: string): void => {
    try {
      options.log(message);
    } catch {
      // logging must never affect the IPC call
    }
  };

  const observe = (channel: string): void => {
    if (loggedUnlisted.has(channel)) return;
    if (isAllowlistedChannel(channel, list)) return;
    if (loggedUnlisted.size >= cap) {
      if (!capReported) {
        capReported = true;
        write(`[IPC] Channel allowlist: log limit (${cap}) reached; further unlisted channels are not logged`);
      }
      return;
    }
    loggedUnlisted.add(channel);
    write(`[IPC] Channel not on the allowlist (log-only): ${channel}`);
  };
  return Object.assign(observe, { trackedChannels: () => loggedUnlisted.size });
}
