import type { Catalog } from '../../types';
import type source from '../en/attachments';

const attachments: Catalog<typeof source> = {
  attach: 'Dateien anhängen',
  accepts: 'PDF, Word (.docx), Text, Markdown oder CSV · je bis {limitMb} MB',
  dropHere: 'Dateien zum Anhängen hier ablegen',
  dropHint: 'Bis zu {max} Dateien, je {limitMb} MB',
  listLabel: 'Zu sendende Dateien',
  uploading: 'Wird hochgeladen …',
  uploadingProgress: 'Wird hochgeladen, {percent} %',
  ready: 'Bereit',
  failed: 'Nicht angehängt',
  remove: '{name} entfernen',
  retry: '{name} erneut versuchen',
  added: '{name} angehängt.',
  removed: '{name} entfernt.',
  waitForUploads: 'Warte, bis die Dateien fertig hochgeladen sind.',
  removeFailed: 'Entferne die Dateien, die nicht angehängt werden konnten, und sende dann.',
  unavailable: 'Datei-Uploads sind auf diesem Server nicht verfügbar.',
  filesLabel: 'Angehängte Dateien',
  downloadHint: '(herunterladen)',
  ownerOnly: 'Nur du kannst diese Dateien herunterladen.',
  count: '{count, plural, one {# Datei} other {# Dateien}}',
  meta: '{type} · {size}',
  pages: '{count, plural, one {# Seite} other {# Seiten}}',
  types: {
    pdf: 'PDF',
    docx: 'Word',
    txt: 'Text',
    md: 'Markdown',
    csv: 'CSV',
  },
};

export default attachments;
