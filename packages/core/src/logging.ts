import { inspect } from 'node:util';

/* eslint-disable no-console -- centralized log sink for bridge/runtime/channel modules */

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN =
  /(^|_|-)(secret|token|authorization|cookie|credential|passwd|password)(_|-|$)|^authorization$/i;

export function logDebug(label: string, payload?: unknown): void {
  if (typeof payload === 'undefined') {
    console.log(label);
    return;
  }
  console.log(label, formatForLog(payload));
}

export function logWarn(label: string, payload?: unknown): void {
  if (typeof payload === 'undefined') {
    console.warn(label);
    return;
  }
  console.warn(label, formatForLog(payload));
}

export function logError(label: string, payload?: unknown): void {
  if (typeof payload === 'undefined') {
    console.error(label);
    return;
  }
  console.error(label, formatForLog(payload));
}

export function formatForLog(value: unknown): string {
  return inspect(sanitizeForLog(value), {
    depth: null,
    compact: false,
    breakLength: 120,
    maxArrayLength: null,
    maxStringLength: null
  });
}

export function sanitizeForLog(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

export function errorToLogObject(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'undefined') {
    return value;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Error) {
    return errorToLogObject(value);
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      length: value.length
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return '[Circular]';
    }
    seen.add(value as object);

    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entryValue]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          return [key, REDACTED];
        }
        return [key, sanitizeValue(entryValue, seen)];
      }
    );

    seen.delete(value as object);
    return Object.fromEntries(entries);
  }

  return String(value);
}
