export class BacklinkError extends Error {
  constructor(
    message: string,
    public httpStatus: number,
    public cooldownExpiresAt?: Date,
  ) {
    super(message);
    this.name = 'BacklinkError';
  }
}
