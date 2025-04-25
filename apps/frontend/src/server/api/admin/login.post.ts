export default eventHandler(async event => {
  const config = useRuntimeConfig(event);
  const { username, password } = await readBody(event);

  if (username !== config.admin.username || password !== config.admin.password) {
    throw createError({ statusCode: 401, message: 'Wrong password' });
  }

  try {
    await setUserSession(event, {
      user: {
        login: 'admin',
      },
      loggedInAt: Date.now(),
    });
  } catch (error) {
    throw createError({ statusCode: 500, message: 'Failed to set user session' });
  }

  return setResponseStatus(event, 201);
});
