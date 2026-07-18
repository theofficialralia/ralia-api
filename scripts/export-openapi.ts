/**
 * Writes the OpenAPI document to docs/openapi.json.
 *
 * Generated from the code and sharing its definition with the runtime mount
 * (src/swagger.ts), so the committed spec cannot drift from the running API.
 * Together with scripts/verify-loop.sh this is the §10 gate artifact: the frozen
 * contract, plus a script that exercises it end to end.
 *
 * Boots the app without listening — no port bound.
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppModule } from '../src/app.module';
import { buildOpenApiConfig } from '../src/swagger';

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'development';

  const app = await NestFactory.create(AppModule, { logger: false });
  // Mirror main.ts so the exported paths match what the server actually serves.
  app.setGlobalPrefix('v1', { exclude: ['r/:token', 'health'] });
  await app.init();

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());

  const out = join(__dirname, '..', 'docs', 'openapi.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {});
  const operations = paths.reduce(
    (n, p) => n + Object.keys(document.paths[p] ?? {}).length,
    0,
  );
  console.log(`→ docs/openapi.json  (${paths.length} paths, ${operations} operations)`);

  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
