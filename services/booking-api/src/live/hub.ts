// One Redis subscriber connection per API process, shared by every open SSE stream.
//
//   workers (live-fanout, notifier, ...) --PUBLISH doctor:<id> / patient:<id>--> Redis --> this hub --> SSE clients
//
// Redis pub/sub is fire-and-forget: a message published while nobody listens is gone. That's fine here, because
// a live event only says "refetch"; the truth is always in Postgres. Run 1 or 10 API instances: each has its own
// subscription, so every browser gets the event whichever instance it is connected to.
import { Redis } from 'ioredis';

type Listener = (message: string) => void;

export class LiveHub {
  private readonly sub: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(redisUrl: string) {
    this.sub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.sub.on('error', () => {}); // reconnects on its own; /health reports Redis status
    this.sub.on('message', (channel, message) => {
      for (const fn of this.listeners.get(channel) ?? []) fn(message);
    });
  }

  /** Returns an unsubscribe function. The Redis SUBSCRIBE happens only for the first listener on a channel. */
  async subscribe(channel: string, fn: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      if (this.sub.status === 'wait') await this.sub.connect();
      await this.sub.subscribe(channel);
    }
    set.add(fn);
    return async () => {
      set!.delete(fn);
      if (set!.size === 0 && this.listeners.get(channel) === set) {
        this.listeners.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  async close() {
    this.sub.disconnect();
  }
}
