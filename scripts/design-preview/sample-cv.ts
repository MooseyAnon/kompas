// A small, text-based sample CV in the shape the deterministic parser reads.
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const lines = [
  'Name: Alex Morgan',
  'Email: alex.morgan@example.test',
  'Location: London',
  'Experience',
  'Senior Product Designer at Northwind Payments',
  '2021 - 2026',
  'Product Designer at Contoso Finance',
  '2018 - 2021',
  'Education',
  'BA Product Design at University of the Arts',
  '2015 - 2018',
  'Skills',
  'Product design, Design systems, User research, Figma',
];

export async function writeSampleCv(file: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  lines.forEach((line, i) =>
    page.drawText(line, { x: 50, y: 760 - 20 * i, size: 12, font }),
  );
  fs.writeFileSync(file, await doc.save());
  return file;
}
