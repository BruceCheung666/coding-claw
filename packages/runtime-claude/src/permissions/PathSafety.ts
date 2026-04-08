import { posix, win32 } from 'node:path';
import type { PermissionReason, PermissionReasonKind } from '@coding-claw/core';

const SENSITIVE_PATTERNS = [
  '/.ssh/',
  '/.gnupg/',
  '/private_key',
  '/id_rsa',
  '/id_ed25519',
  '/id_ecdsa',
  '/id_dsa'
];

const SENSITIVE_SUFFIXES = ['.pem', '.key'];

const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development'
]);

const PROTECTED_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
  'settings.json',
  'settings.local.json'
]);

const PROTECTED_DIRECTORIES = new Set(['.git', '.vscode', '.idea', '.claude']);

export type PathSafetyResult =
  | { status: 'safe' }
  | { status: 'ask'; reason: PermissionReason }
  | { status: 'deny'; reason: PermissionReason };

export function getResolvedFilePath(
  toolInput: Record<string, unknown>,
  cwd: string
): string | undefined {
  const raw =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.path === 'string'
        ? toolInput.path
        : undefined;

  if (!raw) {
    return undefined;
  }

  const pathApi = getPathApi(raw, cwd);
  return pathApi.resolve(cwd, raw);
}

export function isWithinWorkspaceOrAllowedDirectories(
  targetPath: string,
  cwd: string,
  allowedDirectories: Set<string>
): boolean {
  const pathApi = getPathApi(targetPath, cwd, ...allowedDirectories);
  const resolvedTarget = pathApi.resolve(targetPath);
  const resolvedCwd = pathApi.resolve(cwd);
  if (isSameOrWithinDirectory(resolvedTarget, resolvedCwd, pathApi)) {
    return true;
  }

  for (const directory of allowedDirectories) {
    if (
      isSameOrWithinDirectory(
        resolvedTarget,
        pathApi.resolve(directory),
        pathApi
      )
    ) {
      return true;
    }
  }

  return false;
}

export function evaluateFilePathAccess(
  resolvedPath: string,
  options: {
    cwd: string;
    allowedDirectories: Set<string>;
    writeIntent: boolean;
  }
): PathSafetyResult {
  const pathApi = getPathApi(
    resolvedPath,
    options.cwd,
    ...options.allowedDirectories
  );
  const normalized = pathApi.resolve(resolvedPath);

  if (isBlockedDevicePath(normalized)) {
    return {
      status: 'deny',
      reason: createReason(
        'sensitive-path',
        `路径 \`${normalized}\` 指向受保护的系统设备。`
      )
    };
  }

  if (containsUncPath(normalized)) {
    return {
      status: 'ask',
      reason: createReason(
        'sensitive-path',
        `路径 \`${normalized}\` 看起来像网络或 UNC 路径，需要显式批准。`
      )
    };
  }

  if (options.writeIntent && isSensitivePath(normalized)) {
    return {
      status: 'ask',
      reason: createReason(
        'sensitive-path',
        `目标路径 \`${normalized}\` 属于敏感配置或受保护目录。`
      )
    };
  }

  if (
    !isWithinWorkspaceOrAllowedDirectories(
      normalized,
      options.cwd,
      options.allowedDirectories
    )
  ) {
    return {
      status: 'ask',
      reason: createReason(
        options.writeIntent ? 'outside-workspace' : 'read-outside-workspace',
        `目标路径 \`${normalized}\` 位于当前工作区之外，需要显式批准。`
      )
    };
  }

  return { status: 'safe' };
}

function isSensitivePath(filePath: string): boolean {
  const pathApi = getPathApi(filePath);
  const normalized = pathApi.resolve(filePath);
  const normalizedSlashes = normalizePathSeparators(normalized);

  if (
    SENSITIVE_PATTERNS.some((pattern) => normalizedSlashes.includes(pattern))
  ) {
    return true;
  }

  if (SENSITIVE_SUFFIXES.some((suffix) => normalizedSlashes.endsWith(suffix))) {
    return true;
  }

  const fileName = pathApi.basename(normalized);
  if (SENSITIVE_FILENAMES.has(fileName) || PROTECTED_FILES.has(fileName)) {
    return true;
  }

  return normalized
    .split(pathApi.sep)
    .some((part) => PROTECTED_DIRECTORIES.has(part));
}

function isBlockedDevicePath(filePath: string): boolean {
  return /^\/dev\/(?!null$)/.test(filePath);
}

function isSameOrWithinDirectory(
  targetPath: string,
  directoryPath: string,
  pathApi: typeof posix | typeof win32
): boolean {
  if (targetPath === directoryPath) {
    return true;
  }

  const relativePath = pathApi.relative(directoryPath, targetPath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !relativePath.includes(`..${pathApi.sep}`)
  );
}

function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function containsUncPath(filePath: string): boolean {
  return filePath.startsWith('\\\\') || filePath.startsWith('//');
}

function isWindowsStylePath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || containsUncPath(filePath);
}

function getPathApi(...paths: string[]): typeof posix | typeof win32 {
  return paths.some((candidate) => isWindowsStylePath(candidate))
    ? win32
    : posix;
}

function createReason(
  kind: PermissionReasonKind,
  message: string
): PermissionReason {
  return {
    kind,
    message
  };
}
