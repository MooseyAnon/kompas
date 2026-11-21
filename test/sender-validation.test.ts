import { describe, expect, it } from 'vitest';
import {
  isAuthorisedSender,
  type SenderInfo,
  type SenderPolicy,
} from '../src/main/ipc/sender-validation';

const policy: SenderPolicy = {
  expectedWebContentsId: 7,
  allowedUrlPrefixes: ['file://', 'http://localhost:5173'],
};

function sender(overrides: Partial<SenderInfo> = {}): SenderInfo {
  return {
    senderId: 7,
    isMainFrame: true,
    frameUrl: 'file:///Applications/CareerWorkspace.app/index.html',
    ...overrides,
  };
}

describe('isAuthorisedSender', () => {
  it('accepts the trusted window top frame from an allowed origin', () => {
    expect(isAuthorisedSender(sender(), policy)).toBe(true);
  });

  it('accepts the dev server origin', () => {
    expect(
      isAuthorisedSender(
        sender({ frameUrl: 'http://localhost:5173/index.html' }),
        policy,
      ),
    ).toBe(true);
  });

  it('rejects a different webContents (spoofed sender)', () => {
    expect(isAuthorisedSender(sender({ senderId: 99 }), policy)).toBe(false);
  });

  it('rejects a sub-frame (injected iframe)', () => {
    expect(isAuthorisedSender(sender({ isMainFrame: false }), policy)).toBe(
      false,
    );
  });

  it('rejects an unexpected origin', () => {
    expect(
      isAuthorisedSender(sender({ frameUrl: 'https://evil.example/' }), policy),
    ).toBe(false);
  });

  it('rejects a missing frame URL', () => {
    expect(isAuthorisedSender(sender({ frameUrl: undefined }), policy)).toBe(
      false,
    );
  });
});
