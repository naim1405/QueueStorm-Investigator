export type IApiResponse<T> = {
  statusCode: number;
  success: boolean;
  message?: string | null;
  meta?:
    | {
        page: number;
        limit: number;
        total: number;
      }
    | undefined;
  data?: T | null | undefined;
};

export type IApiErrorMessage = {
  path: any;
  message: string;
};

export type IApiErrorResponse = {
  statusCode: number;
  message: string;
  errorMessages: IApiErrorMessage[];
};

export type GenerateAITextParams = {
  system: string;
  prompt: string;
};