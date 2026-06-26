import fs from 'fs';
import path from 'path';
import winston from 'winston';
import LokiTransport from 'winston-loki';
import config from '../config';

const isProduction = config.env === 'production';
const logDirectory = path.join(process.cwd(), 'logs');

if (!fs.existsSync(logDirectory)) {
  fs.mkdirSync(logDirectory, { recursive: true });
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metadata = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${stack ?? message}${metadata}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [new winston.transports.Console()];
const lokiEnabled = process.env['LOKI_ENABLED'] === 'true';
const lokiHost = process.env['LOKI_HOST'];
const lokiAppName = process.env['LOKI_APP_NAME'] ?? 'newserver';
const lokiBasicAuth = process.env['LOKI_BASIC_AUTH'];

if (isProduction) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logDirectory, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, 'combined.log'),
    })
  );
}

if (lokiEnabled && lokiHost) {
  transports.push(
    new LokiTransport({
      host: lokiHost,
      labels: {
        app: lokiAppName,
        env: config.env ?? 'development',
      },
      json: true,
      replaceTimestamp: true,
      onConnectionError: (error: unknown) => {
        process.stderr.write(`[winston-loki] connection error: ${String(error)}\n`);
      },
      ...(lokiBasicAuth ? { basicAuth: lokiBasicAuth } : {}),
    }) as unknown as winston.transport
  );
}

const logger = winston.createLogger({
  level: isProduction ? 'http' : 'debug',
  defaultMeta: { service: 'newserver' },
  format: isProduction ? fileFormat : consoleFormat,
  transports,
  exitOnError: false,
});

export default logger;
