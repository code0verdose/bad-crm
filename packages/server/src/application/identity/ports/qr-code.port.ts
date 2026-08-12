/**
 * Rendering an `otpauth://` URI into a scannable image.
 *
 * SVG rather than PNG (STORY-013-01, acceptance 1): a vector renders crisply at any size the client
 * chooses without the server guessing a resolution, and it is markup the response can carry as a
 * string instead of a base64-encoded raster blob.
 */
export interface QrCodePort {
  renderSvg(uri: string): Promise<string>;
}
