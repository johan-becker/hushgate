/** Base class for every error hushgate throws on purpose. */
export class HushgateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration that cannot be used: bad regex, unknown policy, bad port… */
export class ConfigError extends HushgateError {}
