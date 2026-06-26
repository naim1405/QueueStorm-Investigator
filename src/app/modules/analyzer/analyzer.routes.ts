import express from 'express';
import { analyzeTicket } from './analyzer.controllers';

const router = express.Router();

router.post('/', analyzeTicket);

export const analyzerRoutes = router;
