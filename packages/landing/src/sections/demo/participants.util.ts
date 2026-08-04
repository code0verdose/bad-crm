/**
 * The distinct people in a thread, in the order they first speak.
 *
 * The presence row is drawn from the same list of messages the thread is, and somebody who says two
 * things is still one person — rendering the messages directly put the same face in the row twice
 * and gave React two children with the same key.
 */
export const participantsOf = <T extends { author: string }>(messages: readonly T[]): T[] =>
  messages.filter(
    (message, index) => messages.findIndex((other) => other.author === message.author) === index,
  );
