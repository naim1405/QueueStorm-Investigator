import express from 'express';
import { analyzerRoutes } from '../modules/analyzer/analyzer.routes';

const router = express.Router();

const moduleRoutes = [{ path: '/', route: analyzerRoutes }];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
