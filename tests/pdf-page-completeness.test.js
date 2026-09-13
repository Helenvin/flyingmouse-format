const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractPdfRowsByPage } = require('../pdf-table');
const { classifyPdf } = require('../pdf-classifier');
const { convertPdf } = require('../pdf');

async function fixture(t, scan) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-complete-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  if (scan) {
    const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 });
  }
  page.drawText('ARCHIVE COPY FM-2026-0912', { font: await pdf.embedFont(StandardFonts.Helvetica), size: 12, x: 30, y: 810 });
  if (!scan) pdf.addPage([595, 842]);
  const input = path.join(dir, 'input.pdf');
  await fs.writeFile(input, await pdf.save());
  return { dir, input };
}

for (const target of ['txt', 'html', 'md']) {
  test(`native header over scan retains the body and native spelling in ${target}`, async t => {
    const { dir, input } = await fixture(t, true);
    const calls = [];
    const output = path.join(dir, `output.${target}`);
    const result = await convertPdf(input, output, target, {
      ocrAvailable: () => true,
      createOcrWorker: async () => ({ terminate: async () => {} }),
      renderPdfTablePage: async (_input, page) => { calls.push(page); return { outputPath: 'scan.png' }; },
      recognizeImageResultWithWorker: async () => ({ text: 'ARCHIVE COPY FM-2026-0912\n采购明细单\n合计 1186.00', confidence: 90, warnings: [{ code: 'OCR_REVIEW_RECOMMENDED' }] })
    });
    const text = await fs.readFile(output, 'utf8');
    assert.match(text, /采购明细单/);
    assert.match(text, /1186\.00/);
    assert.equal((text.match(/ARCHIVE COPY/g) || []).length, 1);
    assert.deepEqual(calls, [1]);
    assert.ok(result.warnings.some(w => w.code === 'OCR_REVIEW_RECOMMENDED'));
  });
}

test('a genuinely empty trailing page needs no OCR and keeps native routing', async t => {
  const { dir, input } = await fixture(t, false);
  const pages = await extractPdfRowsByPage(input);
  assert.equal(pages[1].blank, true);
  assert.equal((await classifyPdf(input)).kind, 'native');
  const output = path.join(dir, 'out.txt');
  await convertPdf(input, output, 'txt', { ocrAvailable: () => false });
  assert.match(await fs.readFile(output, 'utf8'), /ARCHIVE COPY/);
});

test('a native paragraph does not hide a smaller scanned body below it', async t => {
  const { dir } = await fixture(t, false);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  page.drawImage(png, { x: 0, y: 0, width: 595, height: 421 });
  for (let index = 0; index < 7; index++) page.drawText(`Account metadata line ${index}: this record contains a scanned invoice below.`, { font, size: 10, x: 30, y: 810 - index * 18 });
  const input = path.join(dir, 'partial.pdf');
  await fs.writeFile(input, await pdf.save());
  const extracted = await extractPdfRowsByPage(input);
  assert.ok(extracted[0].rows.flat().join('').length > 160);
  assert.equal(extracted[0].imageCoverage, 0.5);
  const output = path.join(dir, 'partial.txt');
  let calls = 0;
  await convertPdf(input, output, 'txt', {
    ocrAvailable: () => true,
    createOcrWorker: async () => ({ terminate: async () => {} }),
    renderPdfTablePage: async () => ({ outputPath: 'scan.png' }),
    recognizeImageResultWithWorker: async () => { calls++; return { text: '采购明细单\n合计1186.00', confidence: 90, warnings: [] }; }
  });
  assert.equal(calls, 1);
  assert.match(await fs.readFile(output, 'utf8'), /1186\.00/);
});

test('native monetary punctuation survives when OCR merges the text into a longer line', async () => {
  const { fillMissingPdfPageText } = require('../pdf');
  const result = await fillMissingPdfPageText('unused.pdf', [{ pageNumber: 1, imageCoverage: 1, rows: [['Total 1186.00']] }], {
    ocrAvailable: () => true,
    createOcrWorker: async () => ({ terminate: async () => {} }),
    renderPdfTablePage: async () => ({ outputPath: 'unused.png' }),
    recognizeImageResultWithWorker: async () => ({ text: 'Invoice Total 118600', confidence: 90, warnings: [] })
  });
  assert.match(result[0].rows.flat().join('\n'), /1186\.00/);
});
