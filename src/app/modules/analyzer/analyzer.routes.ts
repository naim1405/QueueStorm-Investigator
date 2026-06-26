import express from 'express';

const router = express.Router();

router.post('', (_, res) => {
  res.send('Analyzing ticket...');
});

export const analyzerRoutes = router;
