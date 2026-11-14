import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_TEXT,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  historyAttachments,
  readAttachment,
} from '../../packages/work-app/src/attachments.js';

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mocode-work-attachments-'));
  return run(root).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

/** 最小 PDF：内置 Helvetica、每页 36 行，长文自然分页而非把文字放到页外。 */
function makePdf(text: string): Buffer {
  const escape = (value: string): string => value.replace(/([()\\])/g, '\\$1');
  const lines = text.match(/.{1,50}|.+$/gs) ?? [];
  const pages: string[][] = [];
  for (let index = 0; index < Math.max(1, lines.length); index += 36) pages.push(lines.slice(index, index + 36));
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((page, index) => {
    const pageId = pageIds[index]!;
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    const stream = `BT /F1 18 Tf 72 720 Td ${page.map((line) => `(${escape(line)}) Tj 0 -20 Td`).join(' ')} ET`;
    objects[pageId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`));
  }
  const xref = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer));
  return Buffer.concat(chunks);
}

/** DOCX 也是 ZIP；使用平台库生成最小可打开文档，不依赖外部 fixture。 */
function makeDocx(text: string): Buffer {
  const files = new Map<string, Buffer>([
    [
      '[Content_Types].xml',
      Buffer.from(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    ],
    [
      '_rels/.rels',
      Buffer.from(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    ],
    [
      'word/document.xml',
      Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    ],
  ]);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // 通用标志位
    local.writeUInt16LE(8, 8); // deflate 压缩方法
    local.writeUInt32LE(compressed.length, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    chunks.push(local, compressed);
    const directory = Buffer.alloc(46 + nameBytes.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8); // 通用标志位
    directory.writeUInt16LE(8, 10); // deflate 压缩方法
    directory.writeUInt32LE(compressed.length, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    nameBytes.copy(directory, 46);
    central.push(directory);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

test('文本/源码附件保留 UTF-8 正文、处理 BOM 与换行，并明确标记超长截断', () =>
  withRoot(async (root) => {
    const source = path.join(root, 'main.ts');
    fs.writeFileSync(source, '\uFEFFconst answer = 42;\r\n// 中文注释\r\n');
    const result = await readAttachment(source);
    assert.deepEqual(result, {
      attachment: { name: 'main.ts', text: 'const answer = 42;\n// 中文注释\n', truncated: false },
    });
    const long = path.join(root, 'long.md');
    fs.writeFileSync(long, 'x'.repeat(MAX_ATTACHMENT_TEXT + 10));
    const longResult = await readAttachment(long);
    assert.ok('attachment' in longResult);
    assert.equal(longResult.attachment.text?.length, MAX_ATTACHMENT_TEXT);
    assert.equal(longResult.attachment.truncated, true);
    assert.ok(ATTACHMENT_EXTENSIONS.includes('py'));
  }));

test('历史附件还原原文供重新生成，兼容未封装文本并保留图片', () => {
  const image = { type: 'image_url', name: 'shot.png', image_url: { url: 'data:image/png;base64,AAAA' } };
  const wrapped = {
    type: 'text',
    name: 'spec.pdf',
    attachment: true,
    truncated: true,
    text: '用户附件 "spec.pdf" 的提取文本如下。（内容已截断，仅提供前 100000 字符）\n\nPDF 原始正文',
  };
  const plain = { type: 'text', name: 'notes.txt', attachment: true, text: '笔记正文' };
  assert.deepEqual(historyAttachments([{ type: 'text', text: '用户消息' }, image, wrapped, plain]), [
    { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' },
    { name: 'spec.pdf', text: 'PDF 原始正文', truncated: true },
    { name: 'notes.txt', text: '笔记正文', truncated: false },
  ]);
});

test('PDF 文字层和 DOCX 段落都经真实解析器读取；空 PDF 明确报错', () =>
  withRoot(async (root) => {
    const pdf = path.join(root, 'spec.pdf');
    fs.writeFileSync(pdf, makePdf('PDF attachment context 123'));
    const pdfResult = await readAttachment(pdf);
    assert.ok('attachment' in pdfResult, JSON.stringify(pdfResult));
    assert.match(pdfResult.attachment.text ?? '', /PDF attachment context 123/);
    const longPdf = path.join(root, 'long.pdf');
    fs.writeFileSync(longPdf, makePdf('x'.repeat(MAX_ATTACHMENT_TEXT)));
    const longResult = await readAttachment(longPdf);
    assert.ok('attachment' in longResult, JSON.stringify(longResult));
    assert.equal(
      longResult.attachment.truncated,
      true,
      `PDF 页眉占用预算后仍须保留截断标记：${JSON.stringify({ length: longResult.attachment.text?.length, truncated: longResult.attachment.truncated })}`,
    );
    assert.ok((longResult.attachment.text?.length ?? 0) <= MAX_ATTACHMENT_TEXT);
    const docx = path.join(root, 'design.docx');
    fs.writeFileSync(docx, makeDocx('DOCX attachment context 456'));
    const docxResult = await readAttachment(docx);
    assert.ok('attachment' in docxResult, JSON.stringify(docxResult));
    assert.match(docxResult.attachment.text ?? '', /DOCX attachment context 456/);
    const empty = path.join(root, 'empty.pdf');
    fs.writeFileSync(empty, makePdf(''));
    assert.deepEqual(await readAttachment(empty), { error: 'empty_text', name: 'empty.pdf' });
  }));

test('图片仍走 dataUrl；非法 UTF-8、未知格式、超限和损坏文档均不静默入队', () =>
  withRoot(async (root) => {
    const image = path.join(root, 'shot.png');
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(image, data);
    const imageResult = await readAttachment(image);
    assert.deepEqual(imageResult, {
      attachment: { name: 'shot.png', dataUrl: `data:image/png;base64,${data.toString('base64')}` },
    });
    const binary = path.join(root, 'broken.txt');
    fs.writeFileSync(binary, Buffer.from([0xc3, 0x28]));
    assert.deepEqual(await readAttachment(binary), { error: 'invalid_utf8', name: 'broken.txt' });
    const zip = path.join(root, 'archive.zip');
    fs.writeFileSync(zip, 'zip');
    assert.deepEqual(await readAttachment(zip), { error: 'unsupported', name: 'archive.zip' });
    const hugeImage = path.join(root, 'huge.png');
    fs.writeFileSync(hugeImage, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    assert.deepEqual(await readAttachment(hugeImage), { error: 'too_large', name: 'huge.png' });
    const hugeDocument = path.join(root, 'huge.pdf');
    fs.writeFileSync(hugeDocument, Buffer.alloc(MAX_DOCUMENT_BYTES + 1));
    assert.deepEqual(await readAttachment(hugeDocument), { error: 'too_large', name: 'huge.pdf' });
    const brokenPdf = path.join(root, 'broken.pdf');
    fs.writeFileSync(brokenPdf, 'not a pdf');
    assert.deepEqual(await readAttachment(brokenPdf), { error: 'read_failed', name: 'broken.pdf' });
  }));
