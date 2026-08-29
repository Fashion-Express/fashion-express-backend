import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { diskStorage } from 'multer';

/**
 * FR-07.2 / BR-34 / NFR-11 — supporting documents on a bill claim.
 *
 * **BR-34** restricts attachments to a fixed extension whitelist. Anything else
 * is refused — not renamed, not accepted-and-quarantined.
 *
 * **NFR-11** requires uploads to be stored *outside the application's
 * executable path*, so a file that somehow got past the whitelist still could
 * not be served or executed as code. `storage/attachments` sits beside `src`
 * and `dist`, never inside either.
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

/** Outside `dist/`, per NFR-11. Configurable for deployment. */
export const ATTACHMENT_ROOT =
  process.env.ATTACHMENT_ROOT ??
  resolve(process.cwd(), 'storage', 'attachments');

export function ensureAttachmentRoot(): void {
  if (!existsSync(ATTACHMENT_ROOT)) {
    mkdirSync(ATTACHMENT_ROOT, { recursive: true });
  }
}

/**
 * The stored name is generated, never the uploaded one.
 *
 * A caller-supplied filename is an attacker-supplied path: `../../etc/passwd`,
 * a name with a null byte, or a second extension. Generating the name removes
 * the whole class of problem, and the database column stores only this
 * relative path.
 */
export const attachmentStorage = diskStorage({
  destination: (_req, _file, callback) => {
    ensureAttachmentRoot();
    callback(null, ATTACHMENT_ROOT);
  },
  filename: (_req, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    callback(
      null,
      `${Date.now()}-${randomBytes(6).toString('hex')}${extension}`,
    );
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

/** Resolve a stored relative path back to a file, refusing anything outside the root. */
export function resolveAttachment(relative: string): string {
  const full = resolve(join(ATTACHMENT_ROOT, relative));
  if (!full.startsWith(resolve(ATTACHMENT_ROOT))) {
    throw new BadRequestException('Invalid attachment path.');
  }
  return full;
}
