import { errorToLogObject, logDebug, logError } from '@coding-claw/core';

export async function callFeishuApi<T>(
  operation: string,
  request: unknown,
  runner: () => Promise<T>
): Promise<T> {
  logDebug(`[feishu] api request ${operation}`, request);

  try {
    const response = await runner();
    logDebug(`[feishu] api response ${operation}`, response);
    return response;
  } catch (error) {
    logError(`[feishu] api error ${operation}`, {
      request,
      error: errorToLogObject(error)
    });
    throw error;
  }
}
