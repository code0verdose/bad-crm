/** Deliberately broken: the landing ships as static files and calls nothing (EPIC-047). */
export function Network() {
  void globalThis.fetch('https://example.invalid/telemetry');
  return <div />;
}
