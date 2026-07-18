import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * The frozen API contract (handoff §6), served browsable.
 *
 * Disabled in production: it enumerates every endpoint and shape, which is a
 * reconnaissance gift on a money system. Staging keeps it — that is where the
 * designer and any frontend work read the contract from.
 */
/**
 * The document definition, shared by the runtime mount and by
 * scripts/export-openapi.ts so the committed spec cannot drift from the API.
 */
export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('Ralia API')
    .setDescription(
      [
        'Two-sided promotion marketplace — businesses fund campaigns, promoters post them for a fee.',
        '',
        '**Money**: every amount is an integer in minor units (kobo). Responses carry both',
        '`amount_minor` (integer) and `amount_display` (formatted). Never a float.',
        '',
        '**Idempotency**: every mutating money endpoint requires an `Idempotency-Key` header',
        'and rejects the request without one. Replaying a key returns the original result',
        'without moving the balance again.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addGlobalParameters({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Required on mutating money endpoints. A UUID the client generates per intent.',
      schema: { type: 'string', format: 'uuid' },
    })
    .addTag('health', 'Liveness and dependency checks')
    .addTag('ledger', 'Accounts, balances, postings. All money access goes through here.')
    .build();
}

/**
 * Mounts Swagger UI at /docs.
 *
 * Disabled in production: it enumerates every endpoint and shape, which is a
 * reconnaissance gift on a money system. Staging keeps it — that is where the
 * designer and any frontend work read the contract from.
 */
export function setupSwagger(app: INestApplication): string | null {
  if (process.env.NODE_ENV === 'production' && process.env.SWAGGER_ENABLED !== 'true') {
    return null;
  }

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha', operationsSorter: 'alpha' },
    customSiteTitle: 'Ralia API',
  });

  return '/docs';
}
