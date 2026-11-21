import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

const CV_LINES = [
  'Name: Smoke Tester',
  'Email: smoke@example.test',
  'Experience',
  'Data Analyst at Acme Corp',
  '2022 - 2024',
];

export async function writePdf(directory) {
  const file = path.join(directory, 'My Smoke CV.pdf');
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);

  for (const [index, line] of CV_LINES.entries()) {
    page.drawText(line, { x: 50, y: 730 - index * 24, font, size: 12 });
  }

  fs.writeFileSync(file, await document.save());

  return file;
}

export async function writeDocx(directory) {
  const file = path.join(directory, 'Smoke CV.docx');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraphs = CV_LINES.map(
    (line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`,
  ).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));

  return file;
}

export function discoveryConfig() {
  const intent = {
    targetRoles: ['Software Intern', 'Data Analyst'],
    seniority: null,
    field: null,
    location: null,
    targetYear: null,
    companies: [],
    keywords: [],
  };
  const run = {
    maxNewCandidates: 2,
    maxInspectedCandidates: 10,
    maxCollectionPages: 1,
    maxTargetedSearchesPerCandidate: 1,
    maxPagesPerTargetedSearch: 1,
    maxConcurrentWebOperations: 2,
    maxConcurrentExtractions: 1,
    maxTransientRetries: 1,
    deadlineMs: 60000,
  };

  return {
    schemaVersion: 1,
    name: 'Packaged discovery',
    active: true,
    intent,
    query: { strategy: 'deterministic_v1', maxQueries: 2 },
    sources: { collectionProviders: ['linkedin'] },
    run,
  };
}
