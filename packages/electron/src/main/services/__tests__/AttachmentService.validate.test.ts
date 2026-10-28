import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  stagedAttachmentRegistry: { register: vi.fn() },
}));
vi.mock('../analytics/AnalyticsService.ts', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));
vi.mock('../ImageCompressor', () => ({
  compressImage: vi.fn(),
  shouldCompress: () => false,
  ImageCompressionError: class extends Error {},
  HeicDecodeError: class extends Error {},
  UnsupportedFormatError: class extends Error {},
}));
vi.mock('../attachments/attachmentStagingRoot', () => ({
  resolveSavedAttachmentDirectory: (dir: string) => dir,
  workspacePathToAttachmentDir: (p: string) => p,
}));

import { AttachmentService } from '../AttachmentService';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('AttachmentService.validateFile', () => {
  const service = new AttachmentService('/workspace', '/staging');

  it('rejects an .xlsx with the spreadsheet code and a CSV hint', () => {
    const result = service.validateFile(1024, XLSX_MIME, 'vendas.xlsx');
    expect(result.valid).toBe(false);
    expect(result.code).toBe('spreadsheet_unsupported');
    expect(result.error).toContain('CSV');
  });

  it('recognizes spreadsheets by extension when the browser reports no MIME type', () => {
    for (const name of ['a.xls', 'b.xlsm', 'c.xlsb', 'd.ods', 'e.numbers', 'F.XLSX']) {
      const result = service.validateFile(1024, '', name);
      expect(result.code, name).toBe('spreadsheet_unsupported');
    }
  });

  it('keeps the generic message for other unsupported types', () => {
    const result = service.validateFile(1024, 'application/zip', 'archive.zip');
    expect(result.valid).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('Unsupported file type: application/zip');
  });

  it('still accepts CSV', () => {
    expect(service.validateFile(1024, 'text/csv', 'vendas.csv')).toEqual({ valid: true });
  });

  it('never tells a .csv reported as vnd.ms-excel to save itself as CSV', () => {
    const result = service.validateFile(1024, 'application/vnd.ms-excel', 'dados.csv');
    expect(result.valid).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('Unsupported file type: application/vnd.ms-excel');
  });

  it('recognizes an .xlsx sent as application/octet-stream', () => {
    expect(service.validateFile(1024, 'application/octet-stream', 'a.xlsx').code).toBe('spreadsheet_unsupported');
  });

  it('recognizes a spreadsheet MIME in any case without a filename', () => {
    expect(service.validateFile(1024, 'APPLICATION/VND.MS-EXCEL').code).toBe('spreadsheet_unsupported');
  });

  it('keeps the generic message when neither MIME nor filename is known', () => {
    const result = service.validateFile(1024, '', undefined);
    expect(result.code).toBeUndefined();
    expect(result.error).toBe('Unsupported file type: (unknown)');
  });

  it('does not change what is accepted: a supported MIME wins over a spreadsheet extension', () => {
    expect(service.validateFile(1024, 'text/plain', 'x.xlsx')).toEqual({ valid: true });
  });

  it('reports the spreadsheet code before any size check', () => {
    expect(service.validateFile(30 * 1024 * 1024, XLSX_MIME, 'a.xlsx').code).toBe('spreadsheet_unsupported');
  });
});
