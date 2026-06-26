import { Server } from 'http';
import app from './app';
import config from './config';
import logger from './helpers/logger';

let server: Server;

async function bootstrap() {
  try {
    server = app.listen(config.port, () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : config.port;

      logger.info(`Server ready at http://localhost:${port}`);
    });

    server.on('error', (error: Error) => {
      logger.error('Server runtime error', { error });
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Graceful shutdown failed while disconnecting DB', {
          error,
        });
        process.exit(1);
      }
    });

    // Force close after 30 seconds
    setTimeout(() => {
      logger.error(
        'Could not close connections in time, forcefully shutting down'
      );
      process.exit(1);
    }, 30_000);
  }
}

// Error handlers
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception', { error });
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { reason });
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

bootstrap().catch((error) => {
  logger.error('Bootstrap failed', { error });
  process.exit(1);
});
