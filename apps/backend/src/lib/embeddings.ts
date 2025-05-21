import { Env } from '../index';
import { err, ok } from 'neverthrow';
import { tryCatchAsync } from './tryCatchAsync';
import { z } from 'zod';

const embeddingsResponseSchema = z.object({
  embeddings: z.array(z.array(z.number())),
});

export async function createEmbeddings(env: Env, texts: string[]) {
  console.log(`Creating embeddings: ${env.MERIDIAN_ML_SERVICE_URL} ${env.MERIDIAN_ML_SERVICE_API_KEY}`);
  const response = await tryCatchAsync(
    fetch(env.MERIDIAN_ML_SERVICE_URL + '/embeddings', {
      method: 'POST',
      body: JSON.stringify({ texts }),
      headers: {
        'X-API-Token': `Bearer ${env.MERIDIAN_ML_SERVICE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    })
  );
  if (response.isErr()) {
    return err(response.error);
  } else if (!response.value.ok) {
    console.log('failure here: type', typeof response.value);
    console.log('failure here: body', response.value.body);
    console.log('failure here:statusText', response.value.statusText);
    console.log('failure here: status', response.value.status);
    console.log('failure here: headers', response.value.headers);
    console.log('failure here: ok', response.value.ok);
    console.log('failure here: response', response.value.url);
    return err(new Error(`Failed to fetch embeddings: ${response.value.statusText}`));
  }

  const jsonResult = await tryCatchAsync(response.value.json());
  if (jsonResult.isErr()) {
    return err(jsonResult.error);
  }

  const parsedResponse = embeddingsResponseSchema.safeParse(jsonResult.value);
  if (parsedResponse.success === false) {
    return err(new Error(`Invalid response ${JSON.stringify(parsedResponse.error)}`));
  }

  return ok(parsedResponse.data.embeddings);
}
