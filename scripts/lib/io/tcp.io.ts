import { createConnection, type Socket } from 'node:net';

import type { HostPort } from '../connection-target.util.js';
import { describeSocketError } from '../socket-error.util.js';

/**
 * Raw TCP, used by three checks: "is the port open" (preflight), the Redis inline PING and the SMTP
 * greeting. Every call is bounded by an explicit timeout — a stack that hangs instead of refusing
 * is a normal state while Docker starts, and a preflight without a deadline would block `pnpm dev`
 * forever.
 */

const withSocket = <T>(
  target: HostPort,
  timeoutMs: number,
  handle: (socket: Socket, settle: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port });
    let done = false;

    const finish = (action: () => void): void => {
      if (done) return;
      done = true;
      socket.destroy();
      action();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      finish(() =>
        reject(new Error(`no answer from ${target.host}:${target.port} within ${timeoutMs} ms`)),
      ),
    );
    socket.on('error', (error: Error) =>
      finish(() =>
        reject(new Error(`${target.host}:${target.port} — ${describeSocketError(error)}`)),
      ),
    );

    handle(
      socket,
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });

export const connectTcp = async (target: HostPort, timeoutMs: number): Promise<void> =>
  withSocket<void>(target, timeoutMs, (socket, settle) => socket.on('connect', () => settle()));

/** Sends inline commands and returns everything the server said before the deadline. */
export const sendLines = async (
  target: HostPort,
  commands: readonly string[],
  timeoutMs: number,
): Promise<string> =>
  withSocket<string>(target, timeoutMs, (socket, settle) => {
    let received = '';

    socket.on('connect', () => socket.write(`${commands.join('\r\n')}\r\n`));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      // One reply line per command is the whole conversation; waiting for the socket to close
      // would mean waiting for the idle timeout on every run.
      if (received.split('\r\n').filter((line) => line !== '').length >= commands.length) {
        settle(received);
      }
    });
    socket.on('end', () => settle(received));
  });

/** Reads the first thing the server volunteers, such as an SMTP banner. */
export const readBanner = async (target: HostPort, timeoutMs: number): Promise<string> =>
  withSocket<string>(target, timeoutMs, (socket, settle) => {
    socket.on('data', (chunk: Buffer) => settle(chunk.toString('utf8')));
    socket.on('end', () => settle(''));
  });
