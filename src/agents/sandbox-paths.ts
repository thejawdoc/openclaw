import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { assertNoPathAliasEscape, type PathAliasPolicy } from "../infra/path-alias-guards.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const HTTP_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
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
  bindMounts?: SandboxBindMount[];
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
}) {
  const resolved = resolveSandboxPath(params);
  const policy: PathAliasPolicy = {
    allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
    allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink,
  };
  await assertNoPathAliasEscape({
    absolutePath: resolved.resolved,
    rootPath: params.root,
    boundaryLabel: "sandbox root",
    policy,
  });
  const rootResolved = path.resolve(params.root);
  const isUnderWorkspace =
    resolved.resolved === rootResolved || resolved.resolved.startsWith(rootResolved + path.sep);
  if (!isUnderWorkspace && params.bindMounts?.length) {
    const translated = translateContainerPath(resolveToCwd(params.filePath, params.cwd), params.bindMounts);
    if (translated) {
      await assertNoPathAliasEscape({
        absolutePath: translated.hostPath,
        rootPath: translated.bindRoot,
        boundaryLabel: "sandbox bind mount",
        policy,
      });
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
    const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
      fileUrl: candidate,
      sandboxRoot: params.sandboxRoot,
    });
    if (workspaceMappedFromUrl) {
      candidate = workspaceMappedFromUrl;
    } else {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        throw new Error(`Invalid file:// URL for sandboxed media: ${raw}`);
      }
    }
  }
  const containerWorkspaceMapped = mapContainerWorkspacePath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (containerWorkspaceMapped) {
    candidate = containerWorkspaceMapped;
  }
  const tmpMediaPath = await resolveAllowedTmpMediaPath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (tmpMediaPath) {
    return tmpMediaPath;
  }
  const sandboxResult = await assertSandboxPath({
    filePath: candidate,
    cwd: params.sandboxRoot,
    root: params.sandboxRoot,
  });
  return sandboxResult.resolved;
}

function mapContainerWorkspaceFileUrl(params: {
  fileUrl: string;
  sandboxRoot: string;
}): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(params.fileUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") {
    return undefined;
  }
  // Sandbox paths are Linux-style (/workspace/*). Parse the URL path directly so
  // Windows hosts can still accept file:///workspace/... media references.
  const normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  if (
    normalizedPathname !== SANDBOX_CONTAINER_WORKDIR &&
    !normalizedPathname.startsWith(`${SANDBOX_CONTAINER_WORKDIR}/`)
  ) {
    return undefined;
  }
  return mapContainerWorkspacePath({
    candidate: normalizedPathname,
    sandboxRoot: params.sandboxRoot,
  });
}

function mapContainerWorkspacePath(params: {
  candidate: string;
  sandboxRoot: string;
}): string | undefined {
  const normalized = params.candidate.replace(/\\/g, "/");
  if (normalized === SANDBOX_CONTAINER_WORKDIR) {
    return path.resolve(params.sandboxRoot);
  }
  const prefix = `${SANDBOX_CONTAINER_WORKDIR}/`;
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  const rel = normalized.slice(prefix.length);
  if (!rel) {
    return path.resolve(params.sandboxRoot);
  }
  return path.resolve(params.sandboxRoot, ...rel.split("/").filter(Boolean));
}

async function resolveAllowedTmpMediaPath(params: {
  candidate: string;
  sandboxRoot: string;
}): Promise<string | undefined> {
  const candidateIsAbsolute = path.isAbsolute(expandPath(params.candidate));
  if (!candidateIsAbsolute) {
    return undefined;
  }
  const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
  const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
  if (!isPathInside(openClawTmpDir, resolved)) {
    return undefined;
  }
  await assertNoTmpAliasEscape({ filePath: resolved, tmpRoot: openClawTmpDir });
  return resolved;
}

async function assertNoTmpAliasEscape(params: {
  filePath: string;
  tmpRoot: string;
}): Promise<void> {
  await assertNoPathAliasEscape({
    absolutePath: params.filePath,
    rootPath: params.tmpRoot,
    boundaryLabel: "tmp root",
  });
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
