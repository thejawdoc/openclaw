import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

/**
 * A bind mount mapping from host path to container path.
 * Parsed from Docker bind strings like "/host/path:/container/path:rw".
 */
export interface SandboxBindMount {
  hostPath: string;
  containerPath: string;
  mode: string;
}

/**
 * Parse Docker bind mount strings into structured objects.
 * Format: "hostPath:containerPath:mode"
 */
export function parseBindMounts(binds?: string[]): SandboxBindMount[] {
  if (!binds) {
    return [];
  }
  const result: SandboxBindMount[] = [];
  for (const bind of binds) {
    const parts = bind.split(":");
    if (parts.length >= 2) {
      result.push({
        hostPath: parts[0],
        containerPath: parts[1],
        mode: parts[2] ?? "ro",
      });
    }
  }
  return result;
}

/**
 * Translate a container path to its host equivalent using bind mounts.
 * Returns null if the path doesn't match any bind mount.
 */
function translateContainerPath(
  filePath: string,
  bindMounts: SandboxBindMount[],
): { hostPath: string; bindRoot: string } | null {
  const resolved = path.resolve(filePath);
  const sorted = [...bindMounts].toSorted(
    (a, b) => b.containerPath.length - a.containerPath.length,
  );
  for (const mount of sorted) {
    const containerRoot = path.resolve(mount.containerPath);
    if (resolved === containerRoot || resolved.startsWith(containerRoot + "/")) {
      const relative = path.relative(containerRoot, resolved);
      const hostResolved = relative ? path.join(mount.hostPath, relative) : mount.hostPath;
      return { hostPath: hostResolved, bindRoot: mount.hostPath };
    }
  }
  return null;
}

export function resolveSandboxInputPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}

export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  bindMounts?: SandboxBindMount[];
}): {
  resolved: string;
  relative: string;
} {
  const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === "") {
    return { resolved, relative: "" };
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    if (params.bindMounts && params.bindMounts.length > 0) {
      const translated = translateContainerPath(resolved, params.bindMounts);
      if (translated) {
        const bindRelative = path.relative(translated.bindRoot, translated.hostPath);
        return { resolved: translated.hostPath, relative: bindRelative || "" };
      }
    }
    throw new Error(`Path escapes sandbox root (${shortPath(rootResolved)}): ${params.filePath}`);
  }
  return { resolved, relative };
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlink?: boolean;
  bindMounts?: SandboxBindMount[];
}) {
  const resolved = resolveSandboxPath(params);
  const rootResolved = path.resolve(params.root);
  const isUnderWorkspace =
    resolved.resolved === rootResolved || resolved.resolved.startsWith(rootResolved + path.sep);
  if (isUnderWorkspace) {
    await assertNoSymlinkEscape(resolved.relative, rootResolved, {
      allowFinalSymlink: params.allowFinalSymlink,
    });
  } else if (params.bindMounts) {
    const translated = translateContainerPath(
      resolveToCwd(params.filePath, params.cwd),
      params.bindMounts,
    );
    if (translated) {
      const rel = path.relative(translated.bindRoot, translated.hostPath);
      await assertNoSymlinkEscape(rel || "", translated.bindRoot);
    }
  }
  return resolved;
}

export function assertMediaNotDataUrl(media: string): void {
  const raw = media.trim();
  if (DATA_URL_RE.test(raw)) {
    throw new Error("data: URLs are not supported for media. Use buffer instead.");
  }
}

export async function resolveSandboxedMediaSource(params: {
  media: string;
  sandboxRoot: string;
}): Promise<string> {
  const raw = params.media.trim();
  if (!raw) {
    return raw;
  }
  if (HTTP_URL_RE.test(raw)) {
    return raw;
  }
  let candidate = raw;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
    }
  }
  const resolved = await assertSandboxPath({
    filePath: candidate,
    cwd: params.sandboxRoot,
    root: params.sandboxRoot,
  });
  return resolved.resolved;
}

async function assertNoSymlinkEscape(
  relative: string,
  root: string,
  options?: { allowFinalSymlink?: boolean },
) {
  if (!relative) {
    return;
  }
  const rootReal = await tryRealpath(root);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const isLast = idx === parts.length - 1;
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        // Unlinking a symlink itself is safe even if it points outside the root. What we
        // must prevent is traversing through a symlink to reach targets outside root.
        if (options?.allowFinalSymlink && isLast) {
          return;
        }
        const target = await tryRealpath(current);
        if (!isPathInside(rootReal, target)) {
          throw new Error(
            `Symlink escapes sandbox root (${shortPath(rootReal)}): ${shortPath(current)}`,
          );
        }
        current = target;
      }
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

async function tryRealpath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || relative === "") {
    return true;
  }
  return !(relative.startsWith("..") || path.isAbsolute(relative));
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
