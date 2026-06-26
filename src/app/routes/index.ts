import express from 'express';
import { analyzerRoutes } from '../modules/analyzer/analyzer.routes';

const router = express.Router();

router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        message: 'Server is running smoothly',
    });
});

const moduleRoutes = [{ path: '/analyze-ticket', route: analyzerRoutes }];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
