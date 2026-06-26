import type { IApiErrorResponse } from '../interface';

const handleValidationError = (error: any): IApiErrorResponse => {
  const errors = [
    {
      path: '',
      message: error.message,
    },
  ];
  const statusCode = 400;
  return {
    statusCode,
    message: 'Validation Error',
    errorMessages: errors,
  };
};

export default handleValidationError;
