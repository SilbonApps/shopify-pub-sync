// server/secrets.mjs
// Carga los secretos de SSM Parameter Store en process.env una vez por
// arranque en frio. El resto del codigo sigue leyendo process.env.
//
// Si SECRETS_SSM_PREFIX no esta definida (ejecucion local, pruebas), se usa
// lo que haya en process.env y no se llama a SSM.
//
// El SDK v3 viene incluido en el runtime nodejs22.x de Lambda: no se empaqueta.

const SECRET_KEYS = [
  'SHOPIFY_ADMIN_TOKEN', // Admin API (GraphQL + REST)
  'SHOPIFY_WEBHOOK_SECRET', // firma HMAC de los webhooks de la app
];

let loaded = null;

export async function loadSecrets() {
  if (loaded) return loaded;

  const prefix = process.env.SECRETS_SSM_PREFIX;
  if (!prefix) {
    loaded = { source: 'env', missing: [] };
    return loaded;
  }

  const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient({});
  const names = SECRET_KEYS.map((key) => `${prefix}/${key}`);
  const { Parameters = [], InvalidParameters = [] } = await client.send(
    new GetParametersCommand({ Names: names, WithDecryption: true })
  );

  for (const parameter of Parameters) {
    const key = parameter.Name.slice(prefix.length + 1);
    if (!process.env[key]) process.env[key] = parameter.Value;
  }

  const missing = InvalidParameters.map((name) => name.slice(prefix.length + 1));
  if (missing.length > 0) console.warn('[secrets] No estan en SSM:', missing.join(', '));

  loaded = { source: 'ssm', missing };
  return loaded;
}

export function resetSecretsCache() {
  loaded = null;
}
