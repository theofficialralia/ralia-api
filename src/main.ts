import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

// Prisma returns BigInt for money columns; JSON.stringify cannot serialise it.
// Money is rendered explicitly per endpoint (amount_minor + amount_display),
// so this only guards against an accidental raw BigInt reaching a response.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  // rawBody: the Paystack webhook signature is an HMAC over the exact bytes we
  // received, so we need the unparsed body alongside the parsed one.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.setGlobalPrefix('v1', {
    // Tracking must stay reachable and unversioned — handoff §6.
    exclude: ['r/:token', 'health'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const docsPath = setupSwagger(app);

  const port = Number(process.env.PORT ?? 6100);
  await app.listen(port, '127.0.0.1');

  if (docsPath) {
    app.get(Logger).log(`API docs → http://localhost:${port}${docsPath}`);
  }
}

void bootstrap();
