export class RegistryCoreError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RegistryCoreError';
  }
}
