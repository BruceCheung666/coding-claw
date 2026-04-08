import { isAbsolute, win32 } from 'node:path';

export function isCrossPlatformAbsolutePath(filePath: string): boolean {
  return isAbsolute(filePath) || win32.isAbsolute(filePath);
}
