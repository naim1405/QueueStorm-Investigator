import { ZodError } from 'zod';
import type { IApiErrorMessage, IApiErrorResponse } from '../interface';

const handleZodError = (error: ZodError): IApiErrorResponse => {
  const errors: IApiErrorMessage[] = error.issues.map((issue) => {
    return {
      path: issue.path[issue.path.length - 1] ?? '',
      message: issue.message,
    };
  });

  const statusCode = 400;

  return {
    statusCode,
    message: 'Validation Error',
    errorMessages: errors,
  };
};

export default handleZodError;
