import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { call, request, waitFor } from './harness.mjs';

function speechPcm(directory) {
  const aiff = path.join(directory, 'speech.aiff');
  const wav = path.join(directory, 'speech.wav');
  execFileSync('/usr/bin/say', [
    '-o',
    aiff,
    'This is a packaged smoke test. I explain my reasoning clearly and check the results.',
  ]);
  execFileSync('/usr/bin/afconvert', [
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    '-c',
    '1',
    aiff,
    wav,
  ]);
  const bytes = fs.readFileSync(wav);
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);

    if (bytes.toString('ascii', offset, offset + 4) === 'data') {
      return bytes.subarray(offset + 8, offset + 8 + size);
    }

    offset += 8 + size + (size % 2);
  }

  throw new Error('Speech fixture has no PCM data');
}

async function captureSpeech(page, pcm) {
  const capture = await call(page, 'audio', 'capture.begin', {
    label: 'Packaged speech fixture',
  });
  const auth = { captureId: capture.captureId, token: capture.token };
  const denied = await request(page, 'audio', 'capture.append', {
    ...auth,
    token: 'invalid-capability-token',
    sequence: 0,
    chunk: pcm.subarray(0, 100).toString('base64'),
  });
  assert.equal(denied.ok, false, 'Audio accepted the wrong capability');

  for (
    let offset = 0, sequence = 0;
    offset < pcm.length;
    offset += capture.maxChunkBytes, sequence++
  ) {
    await call(page, 'audio', 'capture.append', {
      ...auth,
      sequence,
      chunk: pcm
        .subarray(offset, offset + capture.maxChunkBytes)
        .toString('base64'),
    });
  }

  return (await call(page, 'audio', 'capture.complete', auth)).recording;
}

async function checkPlayback(page, recording) {
  const opened = await call(page, 'audio', 'playback.open', {
    id: recording.id,
  });
  const auth = { id: recording.id, token: opened.token };
  const frame = await call(page, 'audio', 'playback.read', {
    ...auth,
    offset: 0,
    length: opened.maxReadBytes,
  });
  assert.equal(
    Buffer.from(frame.chunk, 'base64').toString('ascii', 0, 4),
    'RIFF',
  );
  assert.ok(frame.bytesRead > 44);
  await call(page, 'audio', 'playback.close', auth);
}

export async function audioSmoke(harness, session) {
  const { page } = session;
  const providers = (await call(page, 'audio', 'stt.providers.list')).items;
  const provider = providers.find((item) => item.ready);
  assert.ok(
    provider,
    'Packaged offline speech provider is unavailable; provision assets before packaging',
  );
  const verified = await call(page, 'audio', 'stt.providers.verify', {
    providerId: provider.providerId,
  });
  assert.equal(
    verified.verified,
    true,
    'Packaged speech assets failed verification',
  );
  const recording = await captureSpeech(
    page,
    speechPcm(harness.temporaryDirectory('speech')),
  );
  await checkPlayback(page, recording);
  const { job } = await call(page, 'audio', 'stt.jobs.start', {
    recordingId: recording.id,
    providerId: provider.providerId,
    languageHint: 'en',
  });
  const completed = await waitFor(
    () => call(page, 'audio', 'stt.jobs.get', { jobId: job.id }),
    (value) => !['queued', 'running'].includes(value.job.status),
    'offline transcription',
    {
      timeout: 60000,
      summarize: (value) => ({
        status: value.job.status,
        errorCode: value.job.errorCode,
      }),
    },
  );
  assert.equal(
    completed.job.status,
    'succeeded',
    `Speech job: ${completed.job.errorCode}`,
  );
  const { transcript } = await call(page, 'audio', 'stt.transcripts.get', {
    transcriptId: completed.job.transcriptId,
  });
  assert.equal(transcript.empty, false);
  assert.ok(
    transcript.text.trim().length > 0,
    'Speech fixture produced no transcript',
  );
  const { profile } = session;
  await harness.stop(session);
  const reopened = await harness.launch({ profile });
  const restored = await call(reopened.page, 'audio', 'stt.transcripts.get', {
    transcriptId: transcript.id,
  });
  assert.ok(
    isDeepStrictEqual(restored.transcript, transcript),
    'Transcript changed across packaged restart',
  );
  await checkPlayback(reopened.page, recording);

  return reopened;
}
