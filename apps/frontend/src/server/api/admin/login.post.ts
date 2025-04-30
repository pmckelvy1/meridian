import { z } from 'zod';

const loginSchema = z.object({ username: z.string(), password: z.string() });

export default eventHandler(async event => {
  const config = useRuntimeConfig(event);

  const bodyResult = loginSchema.safeParse(await readBody(event));
  if (bodyResult.success === false) {
    throw createError({ statusCode: 400, message: 'Invalid request body' });
  }

  const { username, password } = bodyResult.data;
  if (username !== config.admin.username || password !== config.admin.password) {
    throw createError({ statusCode: 401, message: 'Wrong password' });
  }

  try {
    await setUserSession(event, { user: { login: 'admin' }, loggedInAt: Date.now() });
  } catch (error) {
    console.error('Failed to set user session', error);
    throw createError({ statusCode: 500, message: 'Failed to set user session' });
  }

  return setResponseStatus(event, 201);
});
