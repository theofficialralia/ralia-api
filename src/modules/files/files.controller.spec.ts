import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { FilesController } from './files.controller';

/**
 * The poster-download rewrite: a Cloudinary URL must be forced to download with an
 * EXTENSION-LESS fl_attachment name. "fl_attachment:ralia-poster.png" is an invalid
 * transformation Cloudinary serves as a 400/404 (the "poster won't download" bug);
 * the admin, which uses the plain URL, is unaffected. These are pure unit tests -
 * prisma and storage are faked, no DB.
 */
describe('FilesController — poster download', () => {
  const CLOUDINARY_URL = 'https://res.cloudinary.com/demo/image/upload/v1720000000/prod/abc123.png';

  function make(opts: { key: string; mime?: string; bytes?: Buffer }) {
    const prisma = { file: { findUnique: async () => ({ storageKey: opts.key, mimeType: opts.mime ?? 'image/png' }) } };
    const storage = {
      name: 'fake',
      signedUrl: async (k: string) => k,
      read: async () => opts.bytes ?? Buffer.from('bytes'),
      put: async () => { throw new Error('unused'); },
      delete: async () => {},
    };
    const controller = new FilesController(prisma as never, storage as never);
    const res = {
      redirect: jest.fn(),
      setHeader: jest.fn(),
      end: jest.fn(),
    } as unknown as Response & { redirect: jest.Mock; setHeader: jest.Mock; end: jest.Mock };
    return { controller, res };
  }

  it('forces a Cloudinary download with an extension-less attachment name', async () => {
    const { controller, res } = make({ key: CLOUDINARY_URL });
    await controller.get('file-1', '1', res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = res.redirect.mock.calls[0][1] as string;
    expect(target).toContain('/upload/fl_attachment:ralia-poster/');
    // The extension must NOT be in the flag - that is exactly what broke it.
    expect(target).not.toContain('fl_attachment:ralia-poster.png');
    // The rest of the URL (version + public id) is preserved.
    expect(target).toContain('/v1720000000/prod/abc123.png');
  });

  it('redirects to the plain URL when not downloading (the admin/inline case)', async () => {
    const { controller, res } = make({ key: CLOUDINARY_URL });
    await controller.get('file-1', undefined, res);

    expect(res.redirect).toHaveBeenCalledWith(302, CLOUDINARY_URL);
  });

  it('streams local bytes with a real, extensioned filename on download', async () => {
    const { controller, res } = make({ key: '/var/data/abc123', mime: 'image/png', bytes: Buffer.from('PNGDATA') });
    await controller.get('file-1', '1', res);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="ralia-poster.png"');
    expect(res.end).toHaveBeenCalledWith(Buffer.from('PNGDATA'));
  });

  it('404s an unknown file', async () => {
    const prisma = { file: { findUnique: async () => null } };
    const storage = { name: 'fake', signedUrl: async (k: string) => k, read: async () => Buffer.from(''), put: async () => ({}) as never, delete: async () => {} };
    const controller = new FilesController(prisma as never, storage as never);
    await expect(controller.get('missing', undefined, {} as Response)).rejects.toBeInstanceOf(NotFoundException);
  });
});
