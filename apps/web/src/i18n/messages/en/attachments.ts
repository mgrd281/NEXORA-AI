const attachments = {
  attach: 'Attach files',
  /** Under the composer while dragging, and as the attach button's description. */
  accepts: 'PDF, Word (.docx), text, Markdown or CSV · up to {limitMb} MB each',
  dropHere: 'Drop files to attach',
  dropHint: 'Up to {max} files, {limitMb} MB each',
  listLabel: 'Files to send',
  uploading: 'Uploading…',
  uploadingProgress: 'Uploading, {percent}%',
  ready: 'Ready',
  failed: 'Not attached',
  remove: 'Remove {name}',
  retry: 'Try {name} again',
  added: '{name} attached.',
  removed: '{name} removed.',
  waitForUploads: 'Wait until the files have finished uploading.',
  removeFailed: 'Remove the files that couldn’t be attached, then send.',
  unavailable: 'File uploads aren’t available on this server.',
  /** Attached files on a request (task detail, thread). */
  filesLabel: 'Attached files',
  downloadHint: '(download)',
  ownerOnly: 'Only you can download these files.',
  count: '{count, plural, one {# file} other {# files}}',
  meta: '{type} · {size}',
  pages: '{count, plural, one {# page} other {# pages}}',
  types: {
    pdf: 'PDF',
    docx: 'Word',
    txt: 'Text',
    md: 'Markdown',
    csv: 'CSV',
  },
};

export default attachments;
