/**
 * THE EXPORT-VARIANT ENCODE CARRIES A DEADLINE (audit 11 Nov, defect 5).
 *
 * `videoExportVariants.refitVideo` was one of the four ffmpeg children that PR
 * #161 did not reach: it ran with no `timeout`, so a wedged encoder kept the
 * variant pass (and the render that awaits it) alive forever. The fix is only
 * worth anything if the child is actually KILLED, so this fixture does not read
 * the source text and does not trust the arguments: it puts a real `ffmpeg` on
 * PATH that never finishes, records its own PID, and then asserts that
 *  (a) the call rejects promptly with the named deadline reason, and
 *  (b) that PID is gone afterwards — the process was killed, not abandoned.
 *
 * $0: no model calls, no network, no ffmpeg work — the child is a shell script.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { refitVideo } from '../videoExportVariants.js';

/** Put a stand-in `ffmpeg`/`ffprobe` on PATH that never finishes, and record
 *  the PID of the process the deadline has to kill. */
function installHangingTools(): { pidFile: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-export-'));
  const pidFile = path.join(dir, 'child.pid');
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const p = path.join(dir, tool);
    // `exec` keeps the recorded PID as the process that is still running, so
    // "is this PID alive?" answers the real question: was the child killed?
    fs.writeFileSync(p, `#!/bin/sh\necho $$ > "$HANG_PIDFILE"\nexec sleep 30\n`, { mode: 0o755 });
  }
  const savedPath = process.env.PATH;
  const savedPidFile = process.env.HANG_PIDFILE;
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  process.env.HANG_PIDFILE = pidFile;
  return {
    pidFile,
    restore: () => {
      process.env.PATH = savedPath;
      if (savedPidFile === undefined) delete process.env.HANG_PIDFILE;
      else process.env.HANG_PIDFILE = savedPidFile;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

async function waitForDeath(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

test('a hung export-variant encode is killed at its deadline, not waited on forever', async () => {
  const tools = installHangingTools();
  const savedBudget = process.env.FFMPEG_TIMEOUT_MS;
  process.env.FFMPEG_TIMEOUT_MS = '250';
  try {
    const started = Date.now();
    let caught: any = null;
    try {
      // The exact call generateVideoExportVariants makes for 16:9 / 1:1 / 2:3.
      await refitVideo('/tmp/never-read.mp4', '/tmp/never-written.mp4', 1920, 1080);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;

    assert.ok(caught, 'a hung variant encode must reject, not resolve and not hang');
    assert.match(String(caught.message), /ffmpeg TIMED OUT after 250ms and was killed/);
    assert.match(String(caught.message), /videoExportVariants\.refitVideo/);
    assert.ok(elapsed < 5_000, `the deadline must fire promptly, took ${elapsed}ms`);

    // The part that makes the deadline real: the child is DEAD, not orphaned.
    assert.ok(fs.existsSync(tools.pidFile), 'the stand-in ffmpeg never started — the fixture proved nothing');
    const pid = Number(fs.readFileSync(tools.pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 0, `unreadable child pid: ${pid}`);
    assert.ok(
      await waitForDeath(pid, 3_000),
      `the hung ffmpeg (pid ${pid}) was still running after the deadline — it was abandoned, not killed`,
    );
  } finally {
    if (savedBudget === undefined) delete process.env.FFMPEG_TIMEOUT_MS;
    else process.env.FFMPEG_TIMEOUT_MS = savedBudget;
    tools.restore();
  }
});
