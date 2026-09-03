import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { diskStorage, memoryStorage, type StorageEngine } from 'multer';

/**
 * FR-07.2 / BR-34 / NFR-11 — supporting documents on a bill claim.
 *
 * **BR-34** restricts attachments to a fixed extension whitelist. Anything else
 * is refused — not renamed, not accepted-and-quarantined.
 *
 * **NFR-11** requires uploads to be stored *outside the application's
 * executable path*, so a file that somehow got past the whitelist still could
 * not be served or executed as code.
 *
 * There are two places that can satisfy that, and which one is in use is a
 * deployment decision, not a code one:
 *
 *  - **`disk`** — `storage/attachments`, beside `src` and `dist` and never
 *    inside either. The default, and what a single long-lived process wants.
 *  - **`blob`** — a Vercel Blob store. A serverless function's filesystem is
 *    read-only apart from `/tmp`, and `/tmp` belongs to one instance and is
 *    discarded with it, so on that host `disk` does not merely degrade: the
 *    upload fails, or succeeds and cannot be read back by the next request.
 *
 * The database column is unchanged and means the same thing under both: an
 * opaque generated key, `<millis>-<12 hex>.<ext>`, never a caller-supplied
 * name. `disk` treats it as a filename under `ATTACHMENT_ROOT` and `blob` as a
 * pathname under `BLOB_PREFIX`, so a row written by one backend still parses
 * under the other — only the bytes need moving.
 */

export const ALLOWED_EXTENSIONS = [
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
];

export type AttachmentBackend = 'disk' | 'blob';

/**
 * Which store this deployment writes to.
 *
 * `ATTACHMENT_STORAGE` decides it outright. Left unset, the presence of
 * `BLOB_READ_WRITE_TOKEN` does — Vercel injects that variable into every
 * environment a Blob store is connected to, so the common case needs no
 * configuration at all, and a machine without a store keeps writing to disk.
 */
export const ATTACHMENT_BACKEND: AttachmentBackend =
  process.env.ATTACHMENT_STORAGE === 'blob' ||
  process.env.ATTACHMENT_STORAGE === 'disk'
    ? process.env.ATTACHMENT_STORAGE
    : process.env.BLOB_READ_WRITE_TOKEN
      ? 'blob'
      : 'disk';

/** Outside `dist/`, per NFR-11. Configurable for a mounted volume. */
export const ATTACHMENT_ROOT =
  process.env.ATTACHMENT_ROOT ??
  resolve(process.cwd(), 'storage', 'attachments');

/**
 * The folder keys live under in the Blob store. Everything a Vercel project
 * puts in Blob shares one store, so the prefix is what keeps claim documents
 * distinguishable from whatever else lands there later.
 */
export const BLOB_PREFIX = 'bill-claims/attachments/';

export function ensureAttachmentRoot(): void {
  if (!existsSync(ATTACHMENT_ROOT)) {
    mkdirSync(ATTACHMENT_ROOT, { recursive: true });
  }
}

/** Multer's file, in the two shapes the engines below produce. */
export interface UploadedAttachment {
  originalname: string;
  /** Written by `diskStorage`; the generated name, already on disk. */
  filename?: string;
  /** Held by `memoryStorage`; the bytes, not yet anywhere. */
  buffer?: Buffer;
  mimetype?: string;
}

/**
 * The stored name is generated, never the uploaded one.
 *
 * A caller-supplied filename is an attacker-supplied path: `../../etc/passwd`,
 * a name with a null byte, or a second extension. Generating the name removes
 * the whole class of problem, and the database column stores only this key.
 */
export function attachmentKey(originalname: string): string {
  const extension = extname(originalname).toLowerCase();
  return `${Date.now()}-${randomBytes(6).toString('hex')}${extension}`;
}

/** What `attachmentKey` produces, and the only shape either backend will read back. */
const KEY_PATTERN = /^\d+-[0-9a-f]{12}(\.[a-z0-9]+)?$/;

/**
 * `diskStorage` writes the file itself during parsing; `memoryStorage` holds it
 * until `storeAttachment` uploads it. The engine is fixed at load because the
 * `FileInterceptor` that uses it is built when the controller class is defined,
 * which is fine: the backend is a property of the deployment, not the request.
 */
export const attachmentStorage: StorageEngine =
  ATTACHMENT_BACKEND === 'blob'
    ? memoryStorage()
    : diskStorage({
        destination: (_req, _file, callback) => {
          ensureAttachmentRoot();
          callback(null, ATTACHMENT_ROOT);
        },
        filename: (_req, file, callback) => {
          callback(null, attachmentKey(file.originalname));
        },
      });

export function attachmentFilter(
  _req: unknown,
  file: { originalname: string },
  callback: (error: Error | null, accept: boolean) => void,
): void {
  const extension = extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    callback(
      new BadRequestException(
        `"${extension || 'that file type'}" is not an accepted attachment. ` +
          `Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`,
      ),
      false,
    );
    return;
  }
  callback(null, true);
}

/**
 * Put an upload where this deployment keeps them and return the key to store.
 *
 * The upload happens before the row is written, so a store that refuses the
 * file fails the request rather than leaving a claim pointing at nothing.
 */
export async function storeAttachment(
  file?: UploadedAttachment,
): Promise<string | null> {
  if (!file) return null;

  // Already written by diskStorage, under the name it generated.
  if (ATTACHMENT_BACKEND === 'disk') return file.filename ?? null;

  const key = attachmentKey(file.originalname);
  const { put } = await loadBlob();

  await put(BLOB_PREFIX + key, file.buffer ?? Buffer.alloc(0), {
    /**
     * NFR-11 again, and the reason this is not `public`. A public blob is
     * readable by anyone holding its URL, which would put the bytes outside
     * the permission check in `BillClaimsController.attachment` — a staff
     * member's receipt is not public data. A private blob is reachable only
     * by a request carrying the store token, so the API stays the only door.
     */
    access: 'private',
    // The key is already unique and already unguessable; a second random
    // suffix would only make the stored value disagree with the column.
    addRandomSuffix: false,
    contentType: file.mimetype || 'application/octet-stream',
  });

  return key;
}

/** A stored attachment, in the form its backend can hand to a response. */
export type OpenedAttachment =
  | { kind: 'file'; path: string }
  | { kind: 'stream'; stream: Readable; contentType: string; size: number };

/**
 * Open a stored attachment, or `null` if the key no longer resolves to bytes.
 *
 * A missing file is not an error worth a stack trace — a store restored from
 * an older snapshot, or a row that outlived a `storage/` directory, should read
 * as "no attachment", which is what the caller already has a 404 for.
 */
export async function openAttachment(
  key: string,
): Promise<OpenedAttachment | null> {
  if (!KEY_PATTERN.test(key)) {
    throw new BadRequestException('Invalid attachment path.');
  }

  if (ATTACHMENT_BACKEND === 'disk') {
    const path = resolveAttachment(key);
    return existsSync(path) ? { kind: 'file', path } : null;
  }

  const { get } = await loadBlob();
  const result = await get(BLOB_PREFIX + key, { access: 'private' });
  if (!result || result.statusCode !== 200) return null;

  return {
    kind: 'stream',
    stream: Readable.fromWeb(result.stream as WebReadableStream<Uint8Array>),
    contentType: result.blob.contentType,
    size: result.blob.size,
  };
}

/**
 * Drop the bytes behind a key. Best-effort, and deliberately so.
 *
 * Every caller runs *after* the row that pointed at the file is gone, so there
 * is nothing left to roll back and nothing the user could usefully do about a
 * failure: the claim is withdrawn, or the new document is attached, either way.
 * What is left is an orphan costing storage, which is a thing to log and not a
 * thing to fail a request over. `false` says the bytes may still be there.
 */
export async function deleteAttachment(key: string): Promise<boolean> {
  if (!KEY_PATTERN.test(key)) return false;

  try {
    if (ATTACHMENT_BACKEND === 'disk') {
      // Not an error: a file already gone is the state this asked for.
      await rm(resolveAttachment(key), { force: true });
      return true;
    }

    const { del } = await loadBlob();
    await del(BLOB_PREFIX + key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a stored key back to a file, refusing anything outside the root.
 *
 * `KEY_PATTERN` already rules out a separator, but this is the check that has
 * to hold if the key shape is ever widened, so it stays.
 */
export function resolveAttachment(relative: string): string {
  const full = resolve(join(ATTACHMENT_ROOT, relative));
  if (!full.startsWith(resolve(ATTACHMENT_ROOT))) {
    throw new BadRequestException('Invalid attachment path.');
  }
  return full;
}

/**
 * `@vercel/blob` is loaded through `import()` rather than a top-level import.
 *
 * Two reasons, and the first is the one that has already cost a deployment: a
 * host that loads this bundle through its own `Module._load` hook decides for
 * itself whether `require()` of a package's ESM entry is allowed, and Vercel's
 * refuses (see `config/auth.ts`). The second is plainer — a deployment on the
 * `disk` backend never touches the store, and this way it never loads the
 * client either.
 */
function loadBlob(): Promise<typeof import('@vercel/blob')> {
  return import('@vercel/blob');
}
