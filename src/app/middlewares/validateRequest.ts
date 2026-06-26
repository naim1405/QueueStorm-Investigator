import { type NextFunction, type Request, type Response } from 'express';
import type { ZodType } from 'zod';

const validateRequest =
  (schema: ZodType) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
        cookies: req.cookies,
      });
      return next();
    } catch (error) {
      next(error);
    }
  };

export default validateRequest;
