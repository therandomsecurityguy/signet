export class TimeAwareRegistryError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'TimeAwareRegistryError';
  }
}
