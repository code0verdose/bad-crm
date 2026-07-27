/**
 * Whether the process has started stopping.
 *
 * Read by readiness: the first thing graceful shutdown does is flip this flag, so the load balancer
 * stops routing new requests here while the in-flight ones finish (stack.md, «main.ts — composition
 * root и graceful shutdown»). The writing side lives in the adapter and is driven by the shutdown
 * handler; nothing in `application` is allowed to declare the process dead.
 */
export interface ProcessLifecyclePort {
  isShuttingDown(): boolean;
}
