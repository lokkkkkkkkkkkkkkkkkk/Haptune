// One way in for every file, wherever it comes from (a button, a drop on the window, the clipboard):
// printed pages (PDF, photos) go to the guided AI reader; music files are read on the device at once.
import { openSheet, toast } from './state.js';
import { importFile } from './importer.js';
import { t } from '../core/i18n.js';

export const isPdf = (f) => /\.pdf$/i.test(f?.name || '') || f?.type === 'application/pdf';
export const isImage = (f) => /^image\//.test(f?.type || '') || /\.(png|jpe?g|heic|heif|webp|gif|bmp|tiff?)$/i.test(f?.name || '');

export async function openFiles(files) {
  const list = [...(files || [])];
  if (!list.length) return;
  const pages = list.filter((f) => isPdf(f) || isImage(f));
  if (pages.length) { openSheet('importWizard', { files: pages }); return; }
  try {
    const { piece, report } = await importFile(list[0]);
    openSheet('report', { pieceId: piece.id, report });
  } catch (err) {
    openSheet('report', { error: err.message || String(err), name: list[0].name });
  }
  if (list.length > 1) toast(t('oneFileAtATime'));
}
