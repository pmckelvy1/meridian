import { Result, ok, err } from 'neverthrow';

/**
 * Wraps an existing Promise, converting resolution to Ok and rejection/throw to Err.
 * The error type is 'unknown' because anything can be thrown.
 *
 * @param promise The promise to wrap.
 * @returns A Promise resolving to a Result<T, unknown>.
 */
export async function tryCatchAsync<T>(promise: Promise<T>): Promise<Result<T, unknown>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (error) {
    // Catches synchronous throws during promise creation *and* promise rejections.
    return err(error);
  }
}
