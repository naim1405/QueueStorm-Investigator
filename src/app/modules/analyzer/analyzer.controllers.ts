import { Request, Response } from "express";
import { analyzerService } from "./analyzer.services";
import { validateRequest } from "./analyzer.validations";

export const analyzeTicket = async (req: Request, res: Response) => {
  const errors = validateRequest(req.body);

  if (errors.length) {
    return res.status(400).json({
      success: false,
      errors,
    });
  }

  const result = await analyzerService(req.body);

  return res.status(200).json(result);
};

