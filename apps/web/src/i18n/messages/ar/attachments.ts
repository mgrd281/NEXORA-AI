import type { Catalog } from '../../types';
import type source from '../en/attachments';

const attachments: Catalog<typeof source> = {
  attach: 'إرفاق ملفات',
  accepts: 'PDF أو Word (.docx) أو نص أو Markdown أو CSV · حتى {limitMb} ميغابايت لكل ملف',
  dropHere: 'أفلت الملفات هنا لإرفاقها',
  dropHint: 'حتى {max} ملفات، {limitMb} ميغابايت لكل ملف',
  listLabel: 'الملفات المراد إرسالها',
  uploading: 'جارٍ الرفع…',
  uploadingProgress: 'جارٍ الرفع، {percent}٪',
  ready: 'جاهز',
  failed: 'لم يُرفق',
  remove: 'إزالة {name}',
  retry: 'إعادة محاولة {name}',
  added: 'أُرفق {name}.',
  removed: 'أُزيل {name}.',
  waitForUploads: 'انتظر حتى يكتمل رفع الملفات.',
  removeFailed: 'أزِل الملفات التي تعذّر إرفاقها، ثم أرسل.',
  unavailable: 'رفع الملفات غير متاح على هذا الخادم.',
  filesLabel: 'الملفات المرفقة',
  downloadHint: '(تنزيل)',
  ownerOnly: 'أنت وحدك تستطيع تنزيل هذه الملفات.',
  count:
    '{count, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}',
  meta: '{type} · {size}',
  pages:
    '{count, plural, zero {لا صفحات} one {صفحة واحدة} two {صفحتان} few {# صفحات} many {# صفحة} other {# صفحة}}',
  types: {
    pdf: 'PDF',
    docx: 'Word',
    txt: 'نص',
    md: 'Markdown',
    csv: 'CSV',
  },
};

export default attachments;
