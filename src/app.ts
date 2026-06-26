import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, {
  type Application,
  type Request,
  type Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import httpStatus from './const/httpStatus';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import logger from './helpers/logger';
import client from 'prom-client';
import responseTime from 'response-time';
import { analyzerRoutes } from './app/modules/analyzer/analyzer.routes';

const app: Application = express();

const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ register: client.register });

// Security middleware
app.use(helmet());
app.use(compression());

// Cookie parsing
const { COOKIE_SECRET } = process.env;
app.use(cookieParser(COOKIE_SECRET));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req: Request, res: Response, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const level =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'http';

    logger.log(level, `${req.method} ${req.originalUrl}`, {
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });

  next();
});

// CORS
const allowedOrigins = process.env['ALLOWED_ORIGINS']?.split(',') ?? [
  'http://localhost:3000',
  'http://localhost:3001',
];

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn('Blocked CORS request', { origin });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

app.get('/', (_req: Request, res: Response) => {
  res.status(httpStatus.OK);
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', client.register.contentType);
  const metrics = await client.register.metrics();
  res.send(metrics);
});

const reqResTimeHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10],
});

const reqResTimeSummary = new client.Summary({
  name: 'http_request_duration_summary_seconds',
  help: 'Summary of HTTP request durations in seconds',
  labelNames: ['method', 'route', 'status_code'],
  percentiles: [0.5, 0.9, 0.99],
});

const totalRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

app.use(
  responseTime((req: Request, res: Response, time: number) => {
    const route = req.route ? req.route.path : 'unknown_route';
    reqResTimeHistogram
      .labels(req.method, route, res.statusCode.toString())
      .observe(time / 1000);
    reqResTimeSummary
      .labels(req.method, route, res.statusCode.toString())
      .observe(time / 1000);
    totalRequests.labels(req.method, route, res.statusCode.toString()).inc();
  })
);

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
  });
});

// API routes
app.use('/analyze-ticket', analyzerRoutes);

// Global error handler
app.use(globalErrorHandler);

// 404 handler
app.use((req: Request, res: Response) => {
  logger.warn('Route not found', { path: req.originalUrl, method: req.method });

  res.status(httpStatus.NOT_FOUND).json({
    success: false,
    message: 'Not Found',
    errorMessages: [
      {
        path: req.originalUrl,
        message: 'API Not Found',
      },
    ],
  });
});

export default app;
