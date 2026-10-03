/**
 * filesystem-kit ships as plain JavaScript with no bundled types. This is the
 * surface NGI relies on, written out so the boundary is typed rather than
 * `any`. Keep it in step with the package's README.
 */
declare module "filesystem-kit" {
  export type LineRange = { start?: number | undefined; end?: number | undefined };

  export type Entry = { name: string; path: string; type: string };
  export type Match = { path: string; line: number; text: string };
  export type Described = { status: string; root: string; service: string };

  /** One machine's disk. Local or remote, the seven operations are the same. */
  export type Filesystem = {
    kind: "local" | "remote";
    root: string;
    describe(): Promise<Described>;
    read(
      path: string,
      options?: { head?: number | undefined; tail?: number | undefined; range?: LineRange | undefined },
    ): Promise<string>;
    write(
      path: string,
      content: string,
      options?: { append?: boolean | undefined; createDirs?: boolean | undefined; range?: LineRange | undefined },
    ): Promise<{ path: string; bytes: number }>;
    modify(
      path: string,
      options?: {
        match?: string | undefined;
        replacement?: string | undefined;
        occurrence?: number | undefined;
        rewrite?: string | undefined;
        range?: LineRange | undefined;
      },
    ): Promise<{ path: string; replacements: number }>;
    remove(
      path: string,
      options?: { recursive?: boolean | undefined; force?: boolean | undefined },
    ): Promise<{ path: string; removed: boolean }>;
    list(directory?: string, options?: { all?: boolean | undefined }): Promise<Entry[]>;
    glob(pattern: string, options?: { path?: string | undefined; all?: boolean | undefined }): Promise<string[]>;
    grep(
      pattern: string | RegExp,
      options?: { path?: string | undefined; ignoreCase?: boolean | undefined; all?: boolean | undefined },
    ): Promise<Match[]>;
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  };

  export type BackendOptions = {
    /** Root of the local machine. Ignored when `baseUrl` is given. */
    cwd?: string | undefined;
    baseUrl?: string | undefined;
    url?: string | undefined;
    token?: string | undefined;
    timeout?: number | undefined;
    retries?: number | undefined;
  };

  /** Local disk when given `cwd`, a remote machine when given `baseUrl`. */
  export function createFilesystem(options?: BackendOptions): Filesystem;
  export function createLocalFilesystem(options?: { cwd?: string | undefined }): Filesystem;
  export function createRemoteFilesystem(options: BackendOptions): Filesystem;

  export type ExecResult = {
    command: string;
    cwd: string;
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
  };

  export type ExecOptions = {
    /** Where to run, relative to the root. Created if it does not exist. */
    directory?: string | undefined;
    timeoutMs?: number | undefined;
    maxOutputBytes?: number | undefined;
    env?: Record<string, string> | undefined;
    /** Set false to make a missing directory an error instead. */
    createDir?: boolean | undefined;
  };

  export class OutsideRootError extends Error {
    readonly code: "EOUTSIDE";
    readonly status: 403;
    readonly requested: string;
    readonly root: string;
  }

  export function read(path: string, options?: { cwd?: string | undefined; head?: number | undefined; tail?: number | undefined; range?: LineRange | undefined }): Promise<string>;
  export function write(path: string, content: string, options?: { cwd?: string | undefined; append?: boolean | undefined; createDirs?: boolean | undefined; range?: LineRange | undefined }): Promise<{ path: string; bytes: number }>;
  export function modify(path: string, options?: { cwd?: string | undefined; match?: string | undefined; replacement?: string | undefined; occurrence?: number | undefined; rewrite?: string | undefined; range?: LineRange | undefined }): Promise<{ path: string; replacements: number }>;
  export function remove(path: string, options?: { cwd?: string | undefined; recursive?: boolean | undefined; force?: boolean | undefined }): Promise<{ path: string; removed: boolean }>;
  export function list(directory?: string, options?: { cwd?: string | undefined; all?: boolean | undefined }): Promise<Entry[]>;
  export function glob(pattern: string, options?: { cwd?: string | undefined; path?: string | undefined; all?: boolean | undefined }): Promise<string[]>;
  export function grep(pattern: string | RegExp, options?: { cwd?: string | undefined; path?: string | undefined; ignoreCase?: boolean | undefined; all?: boolean | undefined }): Promise<Match[]>;
}

/** The service itself, for embedding or for testing a remote backend. */
declare module "filesystem-kit/server" {
  export function createServer(): import("node:http").Server;
}

declare module "filesystem-kit/remote" {
  export { createRemoteFilesystem } from "filesystem-kit";
  export { createRemoteFilesystem as default } from "filesystem-kit";
}
